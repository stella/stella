import { expect, test } from "bun:test";

import { diffDesignBacklog } from "./design-lint-baseline.ts";
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
  "shadcn/no-restyle": restyle,
  "shadcn/no-arbitrary-values": arbitrary,
  "no-raw-overflow-scroll/no-raw-overflow-scroll": overflow,
  "no-imported-class-constant/no-imported-class-constant": imported,
  "require-bounded-request-schema/require-bounded-request-schema": {},
  "no-unbounded-response-body/no-unbounded-response-body": {},
  "eslint/complexity": {},
  "eslint/max-lines-per-function": {},
  "eslint/max-params": {},
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
    ["eslint(complexity)", "eslint/complexity"],
    ["eslint(max-lines-per-function)", "eslint/max-lines-per-function"],
    ["eslint(max-params)", "eslint/max-params"],
  ]);
  expect([...DESIGN_LINT_TRACKED_PLUGINS]).toEqual([
    "shadcn",
    "no-raw-overflow-scroll",
    "no-imported-class-constant",
    "require-bounded-request-schema",
    "no-unbounded-response-body",
    "eslint",
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
