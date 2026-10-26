import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import {
  type CutGateRunner,
  cutMaintenanceRelease,
  type MaintenanceCutEffects,
  MaintenanceReleaseError,
  runCutGate,
} from "./prepare-maintenance-release";
import {
  commandGateFailureReason,
  cutGateClassificationProblems,
  MAINTENANCE_CUT_GATES,
  type PreCutGate,
  preCutGates,
} from "./prepare-maintenance-release-gates";

const RELEASE_TAG_WORKFLOW = nodePath.resolve(
  import.meta.dirname,
  "../.github/workflows/release-tag.yml",
);
const BASE_SHA = "c".repeat(40);
const HIGH_ADVISORY =
  "dependency-audit: new high advisory GHSA-0000-0000-0000 in fixture-package";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const tagRunCommands = (): readonly string[] => {
  const workflow = v.parse(
    v.looseObject({
      jobs: v.looseObject({
        tag: v.looseObject({
          steps: v.array(v.looseObject({ run: v.optional(v.string()) })),
        }),
      }),
    }),
    Bun.YAML.parse(readFileSync(RELEASE_TAG_WORKFLOW, "utf-8")),
  );
  return workflow.jobs.tag.steps.flatMap(({ run }) =>
    run === undefined ? [] : [run.trim()],
  );
};

/** The gate names of release-tag.yml's single `release-gate.sh verdict` line. */
const verdictGates = (): readonly string[] => {
  const verdicts = tagRunCommands().flatMap((run) => {
    const match = /release-gate\.sh"?\s+verdict\s+(.+)$/u.exec(run);
    const names = match?.at(1);
    return names === undefined ? [] : [names.trim().split(/\s+/u)];
  });
  expect(verdicts).toHaveLength(1);
  return verdicts.at(0) ?? [];
};

/** gate name -> the command release-tag.yml runs for it. */
const tagGateCommands = (): ReadonlyMap<string, string> =>
  new Map(
    tagRunCommands().flatMap((run) => {
      const match = /release-gate\.sh"?\s+run\s+([a-z0-9-]+)\s+(.+)$/u.exec(
        run,
      );
      const name = match?.at(1);
      const command = match?.at(2);
      return name === undefined || command === undefined
        ? []
        : [[name, command.trim()] as const];
    }),
  );

const write = (root: string, file: string, contents: string) => {
  const path = nodePath.join(root, file);
  mkdirSync(nodePath.dirname(path), { recursive: true });
  writeFileSync(path, contents);
};

/** A release tree with a pending changeset, as the cut meets it on main. */
const releaseTree = (): string => {
  const root = mkdtempSync(nodePath.join(tmpdir(), "stella-cut-gates-"));
  roots.push(root);
  write(root, "VERSION", "1.2.3\n");
  write(root, "docs/changelog/v1.2.3.md", "# Previous release\n");
  write(
    root,
    "apps/landing/src/data/changelog-release-dates.json",
    '{\n  "v1.2.2": "2026-01-01T00:00:00Z"\n}\n',
  );
  write(
    root,
    "scripts/changeset-policy.json",
    JSON.stringify({
      generatedPaths: [
        "packages/demo/package.json",
        "packages/demo/CHANGELOG.md",
      ],
    }),
  );
  write(root, ".changeset/README.md", "# Changesets\n");
  write(
    root,
    ".changeset/fix-demo.md",
    '---\n"@stll/demo": patch\n---\n\nFix the demo package.\n',
  );
  write(
    root,
    "packages/demo/package.json",
    '{\n  "name": "@stll/demo",\n  "version": "0.1.0"\n}\n',
  );
  write(root, "packages/demo/CHANGELOG.md", "# @stll/demo\n");
  return root;
};

/** Every file under the tree with its bytes, in a stable order. */
const snapshot = (root: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry): [string, string] => {
        const path = nodePath.join(entry.parentPath, entry.name);
        return [repoRelativePath(root, path), readFileSync(path, "utf-8")];
      })
      .toSorted(([left], [right]) => (left < right ? -1 : 1)),
  );

type GateScript = Partial<Record<string, "pass" | "fail" | "throw">>;

type CutRun = {
  error: unknown;
  output: string;
  gatesRun: readonly string[];
  /** Whether the tree was untouched each time a gate ran. */
  untouchedAtEveryGate: boolean;
  versioned: number;
};

const runCut = async (
  root: string,
  script: GateScript,
  args: readonly string[] = [],
): Promise<CutRun> => {
  const before = snapshot(root);
  const output: string[] = [];
  const gatesRun: string[] = [];
  let untouchedAtEveryGate = true;
  let versioned = 0;
  const runGate: CutGateRunner = async (gate) => {
    gatesRun.push(gate.name);
    untouchedAtEveryGate &&=
      JSON.stringify(snapshot(root)) === JSON.stringify(before);
    const verdict = script[gate.name] ?? "pass";
    if (verdict === "throw") {
      throw new Error(`${gate.name} could not run`);
    }
    return verdict === "pass"
      ? { passed: true }
      : { passed: false, detail: `${gate.name} refused: ${HIGH_ADVISORY}` };
  };
  const effects: MaintenanceCutEffects = {
    rootDir: root,
    assertCleanWorktree: () => undefined,
    resolveHeadSha: () => BASE_SHA,
    latestFinalVersion: () =>
      readFileSync(nodePath.join(root, "VERSION"), "utf-8").trim(),
    assertNoOpenRelease: () => undefined,
    openReleasePullRequest: () => undefined,
    runGate,
    queueHistoryWarning: () => null,
    readPreviousRelease: async () => ({
      kind: "published",
      publishedAt: "2026-02-03T04:05:06Z",
    }),
    ensureFreshRecordings: () => undefined,
    // The repository's version script, reduced to the writes it makes.
    versionPackages: (rootDir) => {
      versioned += 1;
      write(
        rootDir,
        "packages/demo/package.json",
        '{\n  "name": "@stll/demo",\n  "version": "0.1.1"\n}\n',
      );
      write(
        rootDir,
        "packages/demo/CHANGELOG.md",
        "# @stll/demo\n\n## 0.1.1\n\n- Fix the demo package.\n",
      );
      rmSync(nodePath.join(rootDir, ".changeset/fix-demo.md"));
    },
    checkPreparedRelease: () => undefined,
    write: (text) => {
      output.push(text);
    },
  };
  // The refusal is the outcome under test: every caller asserts on it.
  const refusal: unknown = await cutMaintenanceRelease(args, effects).then(
    () => null,
    (error: unknown) => error,
  );
  return {
    error: refusal,
    gatesRun,
    output: output.join(""),
    untouchedAtEveryGate,
    versioned,
  };
};

const PRE_CUT_NAMES = preCutGates().map(({ name }) => name);

describe("the maintenance cut checks the tag gates first", () => {
  test("refuses a failing dependency audit and leaves every release file as it was", async () => {
    const root = releaseTree();
    const before = snapshot(root);

    const run = await runCut(root, {
      "dependency-audit": "fail",
      "npm-publish-lag": "fail",
    });

    expect(run.error).toBeInstanceOf(MaintenanceReleaseError);
    const message = run.error instanceof Error ? run.error.message : "";
    expect(message).toContain(
      `2 of ${String(PRE_CUT_NAMES.length)} pre-cut release gates failed on ${BASE_SHA}; nothing was written:`,
    );
    expect(message).toContain(
      `  dependency-audit: dependency-audit refused: ${HIGH_ADVISORY}`,
    );
    expect(message).toContain("  npm-publish-lag: npm-publish-lag refused");
    expect(message).not.toContain("main-health:");
    // Every pre-cut gate ran: the first failure stops nothing.
    expect(run.gatesRun).toEqual(PRE_CUT_NAMES);
    expect(run.untouchedAtEveryGate).toBe(true);
    expect(run.versioned).toBe(0);
    expect(snapshot(root)).toEqual(before);
    // The verdict also says which gates only the tag decides.
    expect(run.output).toContain("release-evidence:");
    expect(run.output).toContain("cli-coupling:");
  });

  test("cuts once every pre-cut gate passes, and only after all of them ran", async () => {
    const root = releaseTree();

    const run = await runCut(root, {});

    expect(run.error).toBeNull();
    expect(run.gatesRun).toEqual(PRE_CUT_NAMES);
    expect(run.untouchedAtEveryGate).toBe(true);
    expect(run.versioned).toBe(1);
    expect(readFileSync(nodePath.join(root, "VERSION"), "utf-8")).toBe(
      "1.2.4\n",
    );
    expect(run.output).toContain(
      `maintenance-release: pre-cut release gates passed: ${PRE_CUT_NAMES.join(", ")}`,
    );
    expect(run.output).toContain("maintenance-release: prepared 1.2.4");
  });

  test("reads a gate that cannot run as a failed gate and still runs the rest", async () => {
    const root = releaseTree();
    const before = snapshot(root);

    const run = await runCut(root, { "main-health": "throw" });

    expect(run.error).toBeInstanceOf(MaintenanceReleaseError);
    expect(run.error instanceof Error ? run.error.message : "").toContain(
      "  main-health: main-health could not run",
    );
    expect(run.gatesRun).toEqual(PRE_CUT_NAMES);
    expect(snapshot(root)).toEqual(before);
  });

  test("--allow-unproven-main passes over main/heavy and main/pr-depth only", async () => {
    const unproven = releaseTree();
    const overridden = await runCut(unproven, { "main-health": "fail" }, [
      "--allow-unproven-main",
    ]);
    expect(overridden.error).toBeNull();
    expect(overridden.output).toContain(
      "maintenance-release: --allow-unproven-main passed; cutting anyway.\nmain-health refused",
    );
    expect(readFileSync(nodePath.join(unproven, "VERSION"), "utf-8")).toBe(
      "1.2.4\n",
    );

    const audited = releaseTree();
    const before = snapshot(audited);
    const refused = await runCut(
      audited,
      { "dependency-audit": "fail", "main-health": "fail" },
      ["--allow-unproven-main"],
    );
    expect(refused.error).toBeInstanceOf(MaintenanceReleaseError);
    const message = refused.error instanceof Error ? refused.error.message : "";
    expect(message).toContain("  dependency-audit: ");
    expect(message).not.toContain("main-health:");
    expect(snapshot(audited)).toEqual(before);

    const strict = releaseTree();
    const unoverridden = await runCut(strict, { "main-health": "fail" });
    expect(unoverridden.error).toBeInstanceOf(MaintenanceReleaseError);
  });
});

describe("every release-tag gate is classified for the cut", () => {
  test("the table names exactly the gates of the release-tag.yml verdict", () => {
    const verdict = verdictGates();
    expect(verdict.length).toBeGreaterThan(0);
    expect(cutGateClassificationProblems(verdict)).toEqual([]);
    expect(
      MAINTENANCE_CUT_GATES.filter(({ source }) => source === "release-tag")
        .map(({ name }) => name)
        .toSorted(),
    ).toEqual(verdict.toSorted());
  });

  test("a tag gate without an entry, or an entry without a tag gate, fails", () => {
    const verdict = verdictGates();
    expect(cutGateClassificationProblems([...verdict, "new-gate"])).toEqual([
      "new-gate: a release-tag.yml gate the maintenance cut does not classify",
    ]);
    expect(
      cutGateClassificationProblems(
        verdict.filter((name) => name !== "dependency-audit"),
      ),
    ).toEqual([
      "dependency-audit: not a gate on the release-tag.yml verdict line",
    ]);
    expect(cutGateClassificationProblems([...verdict, "main-health"])).toEqual([
      "main-health: a release-tag.yml gate classified as cut-only",
      "main-health: a release-tag.yml gate the maintenance cut does not classify",
    ]);
  });

  test("each pre-cut tag gate runs the command the tag runs", () => {
    const commands = tagGateCommands();
    const tagPreCut = preCutGates().filter(
      ({ source }) => source === "release-tag",
    );
    expect(tagPreCut.map(({ name }) => name)).toEqual([
      "dependency-audit",
      "npm-publish-lag",
    ]);
    for (const gate of tagPreCut) {
      expect(gate.check.kind).toBe("command");
      if (gate.check.kind === "command") {
        expect(commands.get(gate.name), gate.name).toBe(
          gate.check.command.join(" "),
        );
      }
    }
    expect(
      MAINTENANCE_CUT_GATES.find(({ name }) => name === "main-health"),
    ).toMatchObject({
      source: "cut",
      stage: "pre-cut",
      overriddenByAllowUnprovenMain: true,
    });
    expect(
      MAINTENANCE_CUT_GATES.filter(
        (gate) =>
          gate.stage === "pre-cut" && gate.overriddenByAllowUnprovenMain,
      ).map(({ name }) => name),
    ).toEqual(["main-health"]);
  });
});

describe("a command gate", () => {
  const gate = (command: readonly string[]): PreCutGate => ({
    name: "fixture",
    source: "cut",
    stage: "pre-cut",
    check: { kind: "command", command },
    overriddenByAllowUnprovenMain: false,
  });
  const context = {
    baseSha: BASE_SHA,
    rootDir: import.meta.dirname,
    write: () => undefined,
  };

  test("fails with the reason the command gives", async () => {
    expect(
      await runCutGate(
        gate(["bash", "-c", "echo 'GHSA-0000 high' >&2; exit 1"]),
        context,
      ),
    ).toEqual({ passed: false, detail: "GHSA-0000 high" });
    expect(await runCutGate(gate(["bash", "-c", "exit 0"]), context)).toEqual({
      passed: true,
    });
  });

  test("reports annotations first, then the last stderr line, then the exit", () => {
    expect(
      commandGateFailureReason({
        exitCode: 1,
        stderr: "noise\n::error::first\n",
        stdout: "::error file=x::second\n",
      }),
    ).toBe("second; first");
    expect(
      commandGateFailureReason({
        exitCode: 2,
        stderr: "one\nlast line\n\n",
        stdout: "",
      }),
    ).toBe("last line");
    expect(
      commandGateFailureReason({ exitCode: 3, stderr: "", stdout: "" }),
    ).toBe("exit 3");
  });
});
