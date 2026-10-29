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
const b = "opacity-0 hover:opacity-100 any-pointer-coarse:opacity-100";
const c = "md:opacity-0 md:group-hover:opacity-100";
const d = "opacity-0 data-[state=open]:opacity-100";
const e = "opacity-0 group-hover/card:opacity-100 group-data-[active=true]/card:opacity-100";`),
  ).toEqual([]);
});

test("requires a touch visibility decision that works without hover", async () => {
  expect(
    await lint(`const a = "opacity-0 group-hover:opacity-100 pointer-coarse:cursor-pointer";
const b = "opacity-0 group-hover:opacity-100 pointer-coarse:hover:opacity-100";
const c = "opacity-0 group-hover:opacity-100 pointer-coarse:visible";
const d = "invisible hover:visible pointer-coarse:opacity-100";
const e = "opacity-0 invisible hover:opacity-100 hover:visible pointer-coarse:opacity-100";
const f = "opacity-0 hover:opacity-100 md:pointer-coarse:opacity-100";
const g = "opacity-0 hover:opacity-100 pointer-coarse:hidden";
const h = "invisible hover:visible any-pointer-coarse:visible";
const i = "opacity-0 invisible hover:opacity-100 hover:visible pointer-coarse:opacity-100 pointer-coarse:visible";`),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("accepts decoration but not an overlay that takes the pointer", async () => {
  expect(
    await lint(`export const a = () => <span aria-hidden="true" className="opacity-0 group-hover:opacity-100" />;
export const b = () => <ChevronIcon className="opacity-0 group-hover:opacity-100" />;
const c = "pointer-events-none opacity-0 group-hover/row:opacity-100";
const d = "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100";`),
  ).toEqual([4]);
});
