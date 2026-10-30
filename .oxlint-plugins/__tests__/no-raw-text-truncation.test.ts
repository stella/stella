import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-raw-text-truncation";

test("rejects every raw truncation utility, behind any variant or marker", async () => {
  expect(
    await lintSingleRule(
      RULE,
      'const c0 = "min-w-0 truncate";\nconst c1 = "line-clamp-2";\nconst c2 = "overflow-hidden text-ellipsis whitespace-nowrap";\nconst c3 = "sm:truncate";\nconst c4 = "group-hover/row:line-clamp-3";\nconst c5 = "!truncate";\nconst c6 = "truncate!";\nconst c7 = "line-clamp-[7]";',
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("reads className, cn() arguments, template chunks and class constants", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `declare const cn: (...classes: unknown[]) => string;
declare const compact: boolean;
export const a = <span className="block truncate">Name</span>;
export const b = <span className={cn("block", compact && "line-clamp-2")}>Name</span>;
export const c = <span className={\`block \${compact ? "" : "px-1"} truncate\`}>Name</span>;
const LABEL_CLASS_NAME = "min-w-0 truncate text-sm";`,
      { sourcePath: "apps/web/src/components/label.tsx" },
    ),
  ).toEqual([3, 4, 5, 6]);
});

test("accepts box clipping, a lifted clamp and a boolean truncate prop", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `declare const Pill: (props: { truncate?: boolean; children: string }) => null;
export const a = <div className="min-w-0 overflow-hidden text-clip" />;
export const b = <p className="md:line-clamp-none">Text</p>;
export const c = <Pill truncate>Name</Pill>;
const truncateLabel = (value: string) => value.slice(0, 10);`,
      { sourcePath: "apps/web/src/components/pill.tsx" },
    ),
  ).toEqual([]);
});

test("an explained disable directive exempts one layout wrapper", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `export const a = (
  // oxlint-disable-next-line no-raw-text-truncation/no-raw-text-truncation -- clips a row of icons, not text
  <div className="flex truncate" />
);
export const b = <div className="flex truncate" />;`,
      { sourcePath: "apps/web/src/components/icons-row.tsx" },
    ),
  ).toEqual([5]);
});

test("the sanctioned owner may spell the utilities it wraps", async () => {
  const source =
    'const LINES = { 1: "block min-w-0 truncate", 2: "line-clamp-2" };';
  const [owner, caller] = await Promise.all([
    lintSingleRule(RULE, source, {
      sourcePath: "packages/ui/src/components/truncated-text.tsx",
    }),
    lintSingleRule(RULE, source, {
      sourcePath: "packages/ui/src/components/not-truncated-text.tsx",
    }),
  ]);
  expect(owner).toEqual([]);
  expect(caller).toEqual([1, 1]);
});
