import { expect, test } from "bun:test";

import { diffShadcnBacklog } from "./shadcn-lint-baseline.ts";
import type { ShadcnLintBacklog } from "./shadcn-lint-policy.ts";

const backlog = (
  restyle: Record<string, number>,
  arbitrary: Record<string, number> = {},
): ShadcnLintBacklog => ({
  "shadcn/no-restyle": restyle,
  "shadcn/no-arbitrary-values": arbitrary,
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

  expect(diffShadcnBacklog(current, baseline)).toEqual({
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

  expect(diffShadcnBacklog(current, baseline)).toEqual({
    improved: [],
    regressed: [],
    stale: [],
  });
});

test("each rule is budgeted on its own", () => {
  const baseline = backlog(
    { "apps/web/src/a.tsx": 1 },
    { "apps/web/src/a.tsx": 1 },
  );
  const current = backlog(
    { "apps/web/src/a.tsx": 1 },
    { "apps/web/src/a.tsx": 2 },
  );

  expect(diffShadcnBacklog(current, baseline).regressed).toEqual([
    "shadcn/no-arbitrary-values apps/web/src/a.tsx (2, baseline 1)",
  ]);
});
