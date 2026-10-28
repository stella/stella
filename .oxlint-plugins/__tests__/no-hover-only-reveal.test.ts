import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  await lintSingleRule("no-hover-only-reveal", source, {
    sourcePath: "component.tsx",
  });

test("rejects controls hidden at rest and revealed only by hover", async () => {
  expect(
    await lint(`const a = "opacity-0 group-hover:opacity-100";
const b = "opacity-0! group-hover/row:opacity-100!";
const c = "invisible hover:visible";
const d = "opacity-0 peer-hover:opacity-100 focus-visible:opacity-100";`),
  ).toEqual([1, 2, 3, 4]);
});

test("accepts a touch reveal, a variant-only hide and a state reveal", async () => {
  expect(
    await lint(`const a = "opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100";
const b = "opacity-0 hover:opacity-100 [@media(hover:none)]:opacity-100";
const c = "md:opacity-0 md:group-hover:opacity-100";
const d = "opacity-0 data-[state=open]:opacity-100";
const e = "opacity-0 group-hover/card:opacity-100 group-data-[active=true]/card:opacity-100";`),
  ).toEqual([]);
});

test("accepts decoration but not an overlay that takes the pointer", async () => {
  expect(
    await lint(`export const a = () => <span aria-hidden="true" className="opacity-0 group-hover:opacity-100" />;
export const b = () => <ChevronIcon className="opacity-0 group-hover:opacity-100" />;
const c = "pointer-events-none opacity-0 group-hover/row:opacity-100";
const d = "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100";`),
  ).toEqual([4]);
});
