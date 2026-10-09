import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { analyzeTestSubjectReachability } from "./test-subject-reachability";

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
});
