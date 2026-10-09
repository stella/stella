import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  analyzeTestSubjectReachability,
  checkReachabilityBaselineMembership,
} from "./test-subject-reachability";

const TEST_FILE = "apps/example/src/widget.test.tsx";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const fixture = (testSource: string) => {
  const root = mkdtempSync(path.join(tmpdir(), "subject-reachability-"));
  roots.push(root);
  mkdirSync(path.join(root, "apps/example/src"), { recursive: true });
  writeFileSync(
    path.join(root, "apps/example/src/widget.ts"),
    "export const reduceWidgetState = () => 'real';\nexport const WidgetPanel = () => null;\n",
  );
  writeFileSync(
    path.join(root, "apps/example/src/widget.test.tsx"),
    testSource,
  );
  return { root, files: [TEST_FILE] as const };
};

const git = (root: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return result.stdout.toString().trim();
};

describe("test subject reachability", () => {
  test("reports a stand-in state machine and component", () => {
    const input = fixture(
      "const reduceWidgetState = () => 'stand-in';\nconst WidgetPanel = () => null;\ntest('state', () => reduceWidgetState());\n",
    );
    expect(
      analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([
      {
        file: TEST_FILE,
        kind: "local-export-collision",
        name: "WidgetPanel",
      },
      {
        file: TEST_FILE,
        kind: "local-export-collision",
        name: "reduceWidgetState",
      },
      { file: TEST_FILE, kind: "no-classified-reachability" },
    ]);
  });

  test("follows an alias wrapper to the real subject", () => {
    const input = fixture(
      "import { reduceWidgetState as realReducer } from './widget';\nconst reduce = () => realReducer();\ntest('state', reduce);\n",
    );
    expect(
      analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);

    writeFileSync(
      path.join(input.root, input.files[0]),
      "import { reduceWidgetState as realReducer } from './widget';\nconst reduce = () => 'stand-in';\ntest('state', reduce);\n",
    );
    expect(
      analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([{ file: TEST_FILE, kind: "no-classified-reachability" }]);
  });

  test("does not count an imported subject hidden in an uncalled wrapper", () => {
    const input = fixture(
      "import { reduceWidgetState as realReducer } from './widget';\nconst unused = () => realReducer();\nconst reduceWidgetState = () => 'stand-in';\ntest('state', () => reduceWidgetState());\n",
    );
    expect(
      analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([
      {
        file: TEST_FILE,
        kind: "local-export-collision",
        name: "reduceWidgetState",
      },
      { file: TEST_FILE, kind: "no-classified-reachability" },
    ]);
  });

  test("does not count a type-only reference to an imported subject", () => {
    const input = fixture(
      "import { reduceWidgetState } from './widget';\ntype Subject = typeof reduceWidgetState;\nconst standIn: Subject = () => 'stand-in';\ntest('state', () => standIn());\n",
    );
    expect(
      analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([{ file: TEST_FILE, kind: "no-classified-reachability" }]);
  });

  test("does not count a shadowed local binding as the imported subject", () => {
    const input = fixture(
      "import { reduceWidgetState } from './widget';\ntest('state', () => { const reduceWidgetState = () => 'stand-in'; return reduceWidgetState(); });\n",
    );
    expect(
      analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([{ file: TEST_FILE, kind: "no-classified-reachability" }]);
  });

  test("classifies a spawned source entry", () => {
    const input = fixture(
      "test('cli', () => Bun.spawn(['bun', 'apps/example/src/widget.ts']));\n",
    );
    expect(
      analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("accepts dependency injection and a model beside the real component", () => {
    const input = fixture(
      "import { WidgetPanel, reduceWidgetState } from './widget';\nconst model = () => 'oracle';\nconst makeHarness = (subject: typeof reduceWidgetState) => subject();\ntest('ui', () => { WidgetPanel(); return makeHarness(reduceWidgetState) === model(); });\n",
    );
    expect(
      analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("does not treat a fixture builder name as a subject stand-in", () => {
    const input = fixture(
      "import { reduceWidgetState } from './widget';\nconst widgetFixture = () => ({ state: 'ready' });\ntest('fixture', () => reduceWidgetState(widgetFixture()));\n",
    );
    writeFileSync(
      path.join(input.root, "apps/example/src/widget.ts"),
      "export const widgetFixture = () => ({ state: 'production' });\nexport const reduceWidgetState = (value: unknown) => value;\n",
    );
    expect(
      analyzeTestSubjectReachability({
        repoRoot: input.root,
        files: input.files,
      }),
    ).toEqual([]);
  });

  test("rejects an exception added to the head baseline", () => {
    const root = mkdtempSync(path.join(tmpdir(), "subject-reachability-git-"));
    roots.push(root);
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(
      path.join(root, "scripts/test-subject-reachability-baseline.json"),
      "{}\n",
    );
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    const base = git(root, "rev-parse", "HEAD");
    writeFileSync(
      path.join(root, "scripts/test-subject-reachability-baseline.json"),
      `${JSON.stringify({ [TEST_FILE]: ["no-classified-reachability"] })}\n`,
    );

    expect(checkReachabilityBaselineMembership(root, ["--base", base])).toBe(1);
  });
});
