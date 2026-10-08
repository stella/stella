import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  backlogFromDiagnostics,
  diffDesignBacklog,
  emptyBacklog,
  isBacklogCurrent,
  serializeBacklog,
} from "./design-lint-baseline.ts";
import {
  DESIGN_LINT_BACKLOG_RULES,
  DESIGN_LINT_RULE_BY_DIAGNOSTIC_CODE,
  DESIGN_LINT_TRACKED_PLUGINS,
  type DesignLintBacklog,
  designLintBacklogOverrides,
} from "./design-lint-policy.ts";

const backlog = (
  restyle: Record<string, number>,
  arbitrary: Record<string, number> = {},
  overflow: Record<string, number> = {},
  imported: Record<string, number> = {},
): DesignLintBacklog => ({
  ...emptyBacklog(),
  "shadcn/no-restyle": restyle,
  "shadcn/no-arbitrary-values": arbitrary,
  "no-raw-overflow-scroll/no-raw-overflow-scroll": overflow,
  "no-imported-class-constant/no-imported-class-constant": imported,
});

test("a count above its baseline regresses, a clean file goes stale, a fall improves", () => {
  const baseline = backlog({
    "apps/web/src/a.tsx": 2,
    "apps/web/src/b.tsx": 3,
    "apps/web/src/c.tsx": 1,
    "apps/web/src/d.tsx": 4,
  });
  const current = backlog({
    "apps/web/src/a.tsx": 3,
    "apps/web/src/b.tsx": 3,
    "apps/web/src/d.tsx": 1,
  });

  expect(diffDesignBacklog(current, baseline)).toEqual({
    improved: ["shadcn/no-restyle apps/web/src/d.tsx (1, baseline 4)"],
    regressed: ["shadcn/no-restyle apps/web/src/a.tsx (3, baseline 2)"],
    stale: ["shadcn/no-restyle apps/web/src/c.tsx (0, baseline 1)"],
  });
});

test("a file the baseline does not list is the repository lint's concern", () => {
  const baseline = backlog({ "apps/web/src/a.tsx": 1 });
  const current = backlog(
    { "apps/web/src/a.tsx": 1, "apps/web/src/new.tsx": 5 },
    { "apps/web/src/a.tsx": 2 },
  );

  expect(diffDesignBacklog(current, baseline)).toEqual({
    improved: [],
    regressed: [],
    stale: [],
  });
});

test("each rule is budgeted on its own", () => {
  const baseline = backlog(
    { "apps/web/src/a.tsx": 1 },
    { "apps/web/src/a.tsx": 1 },
    { "apps/web/src/a.tsx": 1 },
    { "apps/web/src/a.tsx": 1 },
  );
  const current = backlog(
    { "apps/web/src/a.tsx": 1 },
    { "apps/web/src/a.tsx": 2 },
    { "apps/web/src/a.tsx": 1 },
    { "apps/web/src/a.tsx": 3 },
  );

  expect(diffDesignBacklog(current, baseline).regressed).toEqual([
    "shadcn/no-arbitrary-values apps/web/src/a.tsx (2, baseline 1)",
    "no-imported-class-constant/no-imported-class-constant apps/web/src/a.tsx (3, baseline 1)",
  ]);
});

// The report names an external preset rule and a local module rule the same
// way, so one mapping covers both. It is derived from the tracked rule ids;
// this pins the shape the derivation assumes against what oxlint emits.
test("a diagnostic code maps to its tracked rule for both plugin kinds", () => {
  expect([...DESIGN_LINT_RULE_BY_DIAGNOSTIC_CODE]).toEqual([
    ["shadcn(no-restyle)", "shadcn/no-restyle"],
    ["shadcn(no-arbitrary-values)", "shadcn/no-arbitrary-values"],
    [
      "no-raw-overflow-scroll(no-raw-overflow-scroll)",
      "no-raw-overflow-scroll/no-raw-overflow-scroll",
    ],
    [
      "no-imported-class-constant(no-imported-class-constant)",
      "no-imported-class-constant/no-imported-class-constant",
    ],
    [
      "require-bounded-request-schema(require-bounded-request-schema)",
      "require-bounded-request-schema/require-bounded-request-schema",
    ],
    [
      "no-unbounded-response-body(no-unbounded-response-body)",
      "no-unbounded-response-body/no-unbounded-response-body",
    ],
    [
      "no-computed-key-record-assignment(no-computed-key-record-assignment)",
      "no-computed-key-record-assignment/no-computed-key-record-assignment",
    ],
    [
      "no-direct-status-set(no-direct-status-set)",
      "no-direct-status-set/no-direct-status-set",
    ],
    ["eslint(complexity)", "eslint/complexity"],
    ["eslint(max-lines-per-function)", "eslint/max-lines-per-function"],
    ["eslint(max-params)", "eslint/max-params"],
    ["react(no-children-prop)", "react/no-children-prop"],
    ["eslint(no-unexpected-multiline)", "eslint/no-unexpected-multiline"],
  ]);
  expect([...DESIGN_LINT_TRACKED_PLUGINS]).toEqual([
    "shadcn",
    "no-raw-overflow-scroll",
    "no-imported-class-constant",
    "require-bounded-request-schema",
    "no-unbounded-response-body",
    "no-computed-key-record-assignment",
    "no-direct-status-set",
    "eslint",
    "react",
  ]);
  expect(DESIGN_LINT_RULE_BY_DIAGNOSTIC_CODE.size).toBe(
    DESIGN_LINT_BACKLOG_RULES.length,
  );
});

// A backlog file keeps the complexity cap that held before the limit was
// ratcheted, so a listed function can still not grow without bound; the
// other rules have no older cap to fall back to.
test("a backlog file drops a size limit to its ceiling, other rules to off", () => {
  const overrides = designLintBacklogOverrides({
    ...backlog({ "apps/web/src/a.tsx": 1 }),
    "eslint/complexity": { "apps/api/src/b.ts": 1 },
    "eslint/max-params": { "apps/api/src/b.ts": 2 },
  });

  expect(overrides).toEqual([
    { files: ["apps/web/src/a.tsx"], rules: { "shadcn/no-restyle": "off" } },
    {
      files: ["apps/api/src/b.ts"],
      rules: { "eslint/complexity": ["error", 50] },
    },
    { files: ["apps/api/src/b.ts"], rules: { "eslint/max-params": "off" } },
  ]);
});

const DIAGNOSTICS = [
  { code: "shadcn(no-restyle)", filename: "apps/web/src/z.tsx" },
  { code: "shadcn(no-restyle)", filename: "apps/web/src/Z.tsx" },
  { code: "shadcn(no-restyle)", filename: "apps/web/src/a-b.tsx" },
  { code: "shadcn(no-restyle)", filename: "apps/web/src/a.b.tsx" },
  { code: "shadcn(no-restyle)", filename: "apps/web/src/a_b.tsx" },
  { code: "shadcn(no-restyle)", filename: "apps/web/src/chat.tsx" },
  { code: "shadcn(no-restyle)", filename: "apps/web/src/hooks.tsx" },
  { code: "shadcn(no-restyle)", filename: "apps/web/src/hooks.tsx" },
  { code: "eslint(max-params)", filename: "apps/api/src/b.ts" },
  { code: "unicorn(no-null)", filename: "apps/api/src/b.ts" },
];

const TRACKED = new Set([
  "apps/web/src/z.tsx",
  "apps/web/src/Z.tsx",
  "apps/web/src/a-b.tsx",
  "apps/web/src/a.b.tsx",
  "apps/web/src/a_b.tsx",
  "apps/web/src/chat.tsx",
  "apps/web/src/hooks.tsx",
  "apps/api/src/b.ts",
]);

// `--write` once sorted files with a bare localeCompare, whose order follows
// the machine's default locale, so two machines wrote different files from
// one tree. The bytes must depend on the findings alone.
test("the serialized baseline is byte-identical in any report order", () => {
  const expected = serializeBacklog(
    backlogFromDiagnostics(DIAGNOSTICS, TRACKED),
  );

  assertProperty(
    "design lint baseline bytes ignore report order",
    fc.property(
      fc.shuffledSubarray(DIAGNOSTICS, { minLength: DIAGNOSTICS.length }),
      (shuffled) => {
        expect(
          serializeBacklog(backlogFromDiagnostics(shuffled, TRACKED)),
        ).toBe(expected);
      },
    ),
  );
  const parsed = JSON.parse(expected);
  expect(parsed).toEqual({
    ...emptyBacklog(),
    "shadcn/no-restyle": {
      "apps/web/src/Z.tsx": 1,
      "apps/web/src/a-b.tsx": 1,
      "apps/web/src/a.b.tsx": 1,
      "apps/web/src/a_b.tsx": 1,
      "apps/web/src/chat.tsx": 1,
      "apps/web/src/hooks.tsx": 2,
      "apps/web/src/z.tsx": 1,
    },
    "eslint/max-params": { "apps/api/src/b.ts": 1 },
  });
  expect(Object.keys(parsed)).toEqual([...DESIGN_LINT_BACKLOG_RULES]);
  expect(Object.keys(parsed["shadcn/no-restyle"])).toEqual([
    "apps/web/src/Z.tsx",
    "apps/web/src/a-b.tsx",
    "apps/web/src/a.b.tsx",
    "apps/web/src/a_b.tsx",
    "apps/web/src/chat.tsx",
    "apps/web/src/hooks.tsx",
    "apps/web/src/z.tsx",
  ]);
});

test("serializing is a fixed point whatever key order it is handed", () => {
  const measured = backlogFromDiagnostics(DIAGNOSTICS, TRACKED);
  const reversed = emptyBacklog();
  for (const rule of DESIGN_LINT_BACKLOG_RULES.toReversed()) {
    reversed[rule] = Object.fromEntries(
      Object.entries(measured[rule]).toReversed(),
    );
  }
  const serialized = serializeBacklog(measured);

  expect(serializeBacklog(reversed)).toBe(serialized);
  expect(serializeBacklog(JSON.parse(serialized))).toBe(serialized);
});

test("a finding in an untracked file stays out of the baseline", () => {
  const measured = backlogFromDiagnostics(
    [
      { code: "shadcn(no-restyle)", filename: "apps/web/src/a.tsx" },
      { code: "shadcn(no-restyle)", filename: "apps/web/src/scratch.tsx" },
    ],
    new Set(["apps/web/src/a.tsx"]),
  );

  expect(measured["shadcn/no-restyle"]).toEqual({ "apps/web/src/a.tsx": 1 });
});

// A merged change took a file from 11 findings to 6 and left its budget at
// 11: the check passed because a fall only printed a hint, so the next
// regeneration showed the drop as an unrelated diff, and the file could have
// regressed back to 11 unnoticed.
test("a fall below the baseline fails the check like a rise does", () => {
  const baseline = backlog({ "apps/api/src/adapter.ts": 11 });

  expect(
    isBacklogCurrent(
      diffDesignBacklog(backlog({ "apps/api/src/adapter.ts": 6 }), baseline),
    ),
  ).toBe(false);
  expect(isBacklogCurrent(diffDesignBacklog(baseline, baseline))).toBe(true);
});
