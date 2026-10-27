import { describe, expect, test } from "bun:test";

import {
  checkProblem,
  checkSources,
  type CiInputs,
  ciReach,
  enumerateSources,
  type Ledger,
  LINT_TAG_MESSAGE,
  parseLedger,
  parseRuleItems,
  readTag,
  type Resolvers,
  testProblem,
} from "./check-instruction-enforcement";

const EMPTY_LEDGER: Ledger = {
  reviewOnlyRules: 0,
  excludedSources: [],
  excludedSections: [],
};

const ACCEPTING: Resolvers = {
  check: () => undefined,
  test: () => undefined,
};

const messagesFor = (
  text: string,
  ledger: Ledger = EMPTY_LEDGER,
  resolvers: Resolvers = ACCEPTING,
): string[] =>
  checkSources(
    [{ file: "RULES.md" }],
    () => text,
    ledger,
    resolvers,
  ).problems.map((problem) => `${String(problem.line)} ${problem.message}`);

describe("parseRuleItems", () => {
  test("reads top-level bullets and numbered items under their heading", () => {
    const items = parseRuleItems(
      [
        "---",
        "name: fixture",
        "---",
        "# Title",
        "",
        "Intro prose is not a rule.",
        "",
        "## Rules",
        "",
        "- first rule",
        "  continues here [review]",
        "  - a nested point stays with its parent",
        "1. numbered rule [review]",
        "",
        "## Other",
        "",
        "* starred rule [review]",
      ].join("\n"),
    );
    expect(items.map(({ line, heading }) => [line, heading])).toEqual([
      [10, "Rules"],
      [13, "Rules"],
      [17, "Other"],
    ]);
    expect(items[0]?.text).toContain("a nested point stays with its parent");
  });

  test("a lazy continuation line belongs to the item", () => {
    const [item] = parseRuleItems(
      "- lock with `SELECT ...\nFOR UPDATE` first [review]\n",
    );
    expect(item?.text.endsWith("[review]")).toBe(true);
  });

  test("an unindented paragraph after a blank line ends the item", () => {
    const [item] = parseRuleItems(
      "- the rule [review]\n\nEnforced by prose.\n",
    );
    expect(item?.text).toBe("- the rule [review]");
  });

  test("list-shaped lines in code fences are not rules", () => {
    expect(parseRuleItems("```md\n- not a rule\n1. nor this\n```\n")).toEqual(
      [],
    );
  });

  test("bold paragraphs are not list items", () => {
    expect(
      parseRuleItems("**Bounded reads.** Never scan everything.\n"),
    ).toEqual([]);
  });
});

describe("readTag", () => {
  test("reads each tag kind and its values", () => {
    expect(readTag("- rule [review]")).toEqual({
      kind: "tagged",
      tag: { kind: "review" },
    });
    expect(readTag("- rule\n  [lint: a/b, c/d]")).toEqual({
      kind: "tagged",
      tag: { kind: "lint", values: ["a/b", "c/d"] },
    });
    expect(readTag("- rule [check: ratchet:as-casts]")).toEqual({
      kind: "tagged",
      tag: { kind: "check", values: ["ratchet:as-casts"] },
    });
  });

  test("a rule without a tag, with two, with a misplaced or an empty one fails", () => {
    expect(readTag("- rule").kind).toBe("missing");
    expect(readTag("- rule [lint: a/b] [review]")).toEqual({
      kind: "multiple",
      count: 2,
    });
    expect(readTag("- [review] then more words").kind).toBe("not-trailing");
    expect(readTag("- rule [test: ]").kind).toBe("empty");
  });

  test("markdown links and checkboxes are not tags", () => {
    expect(readTag("- see [the guide](./guide.md) [review]").kind).toBe(
      "tagged",
    );
    expect(readTag("- [ ] checkbox").kind).toBe("missing");
  });
});

describe("checkSources", () => {
  test("an untagged rule fails with its line", () => {
    expect(messagesFor("## Rules\n\n- an untagged rule\n")).toEqual([
      "3 rule has no enforcement tag ([check: …], [test: …] or [review])",
    ]);
  });

  test("the review count must equal the tree in both directions", () => {
    const text = "- one [review]\n- two [review]\n";
    expect(messagesFor(text, { ...EMPTY_LEDGER, reviewOnlyRules: 2 })).toEqual(
      [],
    );
    expect(messagesFor(text, { ...EMPTY_LEDGER, reviewOnlyRules: 1 })).toEqual([
      "0 2 [review] rules exceed reviewOnlyRules 1: name the mechanism that enforces the new rule",
    ]);
    expect(messagesFor(text, { ...EMPTY_LEDGER, reviewOnlyRules: 3 })).toEqual([
      "0 [review] rules fell to 2: lower reviewOnlyRules from 3 to 2",
    ]);
  });

  test("each check and test value goes to its resolver", () => {
    const seen: string[] = [];
    const report = checkSources(
      [{ file: "apps/api/AGENTS.md" }],
      () => "- b [check: verify, gone]\n- c [test: t.test.ts]\n- d [review]\n",
      { ...EMPTY_LEDGER, reviewOnlyRules: 1 },
      {
        check: (target) => {
          seen.push(`check ${target}`);
          return target === "gone" ? "no such root package script" : undefined;
        },
        test: (testPath) => {
          seen.push(`test ${testPath}`);
          return undefined;
        },
      },
    );
    expect(seen).toEqual(["check verify", "check gone", "test t.test.ts"]);
    expect(report.problems.map(({ message }) => message)).toEqual([
      "[check: gone] no such root package script",
    ]);
    expect(report.census).toEqual({ lint: 0, check: 1, test: 1, review: 1 });
  });

  test("a rule a lint enforces fails: the rule belongs in the lint", () => {
    expect(messagesFor("- a rule [lint: plugin/rule]\n")).toEqual([
      `1 ${LINT_TAG_MESSAGE}`,
    ]);
  });

  test("an excluded section is skipped and a stale exclusion fails", () => {
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      excludedSections: [
        { file: "RULES.md", heading: "Pointers", reason: "links" },
        { file: "RULES.md", heading: "Gone", reason: "removed" },
      ],
    };
    expect(messagesFor("## Pointers\n\n- `docs/a.md`\n", ledger)).toEqual([
      '0 stale excluded section "Gone" in RULES.md (no list item sits under it)',
    ]);
  });

  test("an excluded source is skipped and one that is no source fails", () => {
    const report = checkSources(
      [{ file: "PROCEDURE.md" }],
      () => "- step one\n",
      {
        ...EMPTY_LEDGER,
        excludedSources: [
          { file: "PROCEDURE.md", reason: "a procedure" },
          { file: "DELETED.md", reason: "gone" },
        ],
      },
      ACCEPTING,
    );
    expect(report.problems.map(({ message }) => message)).toEqual([
      "stale excluded source DELETED.md (no longer an instruction source)",
    ]);
    expect(report.checkedSources).toBe(0);
  });
});

describe("parseLedger", () => {
  test("an exclusion needs a reason", () => {
    expect(() =>
      parseLedger(
        JSON.stringify({
          reviewOnlyRules: 0,
          excludedSources: [{ file: "a.md", reason: " " }],
          excludedSections: [],
        }),
      ),
    ).toThrow("must hold reviewOnlyRules and reasoned");
  });
});

describe("checkProblem and testProblem", () => {
  const files = new Set([
    "scripts/guard.ts",
    "scripts/unused.ts",
    "scripts/via-shell.ts",
    "scripts/run-guards.sh",
    "scripts/guard.test.ts",
    "scripts/orphan.test.ts",
    "apps/api/src/a.test.ts",
    "apps/api/src/helper.ts",
    "packages/untested/src/a.test.ts",
    ".oxlint-plugins/__tests__/rule.test.ts",
  ]);
  const inputs: CiInputs = {
    commands: [
      "bun run check:guard\nbash scripts/run-guards.sh",
      "bun --bun turbo run lint",
      "bun --bun turbo run test",
      "bun test scripts/guard.test.ts\nbun scripts/ratchet.ts --check",
    ],
    rootScripts: {
      "check:guard": "bun scripts/guard.ts --check",
      "check:idle": "bun scripts/unused.ts",
    },
    workspaceScripts: {
      "apps/api": { lint: "bun scripts/lint-workspace.ts", test: "bun test" },
      "packages/untested": { lint: "bun scripts/lint-workspace.ts" },
    },
    ratchetIds: new Set(["as-casts"]),
    pullRequestWorkflows: new Set([".github/workflows/ci.yml"]),
    scheduledWorkflows: new Set([".github/workflows/audit.yml"]),
    exists: (repoPath) =>
      files.has(repoPath) ||
      [...files].some((file) =>
        file.startsWith(`${repoPath.replace(/\/$/u, "")}/`),
      ),
    readScript: (repoPath) =>
      repoPath === "scripts/run-guards.sh"
        ? "bun scripts/via-shell.ts\n"
        : undefined,
  };
  const reach = ciReach(inputs);

  test("a root script CI runs, and the paths it reaches, pass", () => {
    expect(checkProblem(inputs, reach, "check:guard")).toBeUndefined();
    expect(checkProblem(inputs, reach, "scripts/guard.ts")).toBeUndefined();
    expect(checkProblem(inputs, reach, "scripts/via-shell.ts")).toBeUndefined();
  });

  test("a script CI never runs fails", () => {
    expect(checkProblem(inputs, reach, "check:idle")).toBe("not run by CI");
    expect(checkProblem(inputs, reach, "scripts/unused.ts")).toBe(
      "not run by CI",
    );
    expect(checkProblem(inputs, reach, "check:absent")).toBe(
      "no such root package script",
    );
    expect(checkProblem(inputs, reach, "scripts/absent.ts")).toBe(
      "no such file",
    );
  });

  test("a turbo task reaches each workspace's script", () => {
    expect(reach.text).toContain("bun scripts/lint-workspace.ts");
  });

  test("a ratchet target names a registered metric", () => {
    expect(checkProblem(inputs, reach, "ratchet:as-casts")).toBeUndefined();
    expect(checkProblem(inputs, reach, "ratchet:missing")).toBe(
      "no ratchet metric missing in scripts/ratchet.ts",
    );
  });

  test("a workflow target runs on pull requests or a schedule", () => {
    expect(
      checkProblem(inputs, reach, ".github/workflows/ci.yml"),
    ).toBeUndefined();
    expect(
      checkProblem(inputs, reach, ".github/workflows/audit.yml"),
    ).toBeUndefined();
    expect(checkProblem(inputs, reach, ".github/workflows/manual.yml")).toBe(
      "not a pull-request, merge-queue or scheduled workflow",
    );
  });

  test("a test path exists, is a test, and a root script test runs in CI", () => {
    expect(
      testProblem(inputs, reach, "apps/api/src/a.test.ts", false),
    ).toBeUndefined();
    expect(testProblem(inputs, reach, "apps/api/src", true)).toBeUndefined();
    expect(
      testProblem(inputs, reach, "scripts/guard.test.ts", false),
    ).toBeUndefined();
    expect(testProblem(inputs, reach, "apps/api/src/gone.test.ts", false)).toBe(
      "no such file or directory",
    );
    expect(testProblem(inputs, reach, "apps/api/src/helper.ts", false)).toBe(
      "not a test file",
    );
    expect(testProblem(inputs, reach, "scripts/orphan.test.ts", false)).toBe(
      "root script test not run by CI",
    );
  });

  test("a workspace test runs only through a reached test task", () => {
    expect(
      testProblem(inputs, reach, "packages/untested/src/a.test.ts", false),
    ).toBe("packages/untested has no test script");
    const lintOnly = ciReach({
      ...inputs,
      commands: ["bun --bun turbo run lint"],
    });
    expect(testProblem(inputs, lintOnly, "apps/api/src/a.test.ts", false)).toBe(
      "workspace tests not run by CI",
    );
  });

  test("a test outside the workspaces and scripts runs only when CI names it", () => {
    expect(
      testProblem(
        inputs,
        reach,
        ".oxlint-plugins/__tests__/rule.test.ts",
        false,
      ),
    ).toBe("test outside a workspace not run by CI");
  });
});

describe("enumerateSources", () => {
  test("reads fragments and modules from the manifest, then local skills", () => {
    const manifest = {
      agents: {
        modules: ["engineering"],
        local: ".ai/local/agents.md",
        scopes: [
          {
            path: "apps/api",
            modules: ["database"],
            local: ".ai/local/api-agents.md",
          },
          { path: "apps/mobile", modules: ["engineering"] },
        ],
      },
    };
    expect(
      enumerateSources(manifest, [".ai/local-skills/conventions-db/SKILL.md"]),
    ).toEqual([
      { file: ".ai/local-skills/conventions-db/SKILL.md" },
      { file: ".ai/local/agents.md" },
      { file: ".ai/local/api-agents.md" },
      { file: ".ai/shared/modules/database.md" },
      { file: ".ai/shared/modules/engineering.md" },
    ]);
  });
});
