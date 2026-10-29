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

test("accepts a touch reveal, a scoped touch reveal and a state reveal", async () => {
  expect(
    await lint(`const a = "opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100";
const b = "opacity-0 hover:opacity-100 any-pointer-coarse:opacity-100";
const c = "md:opacity-0 md:group-hover:opacity-100 pointer-coarse:opacity-100";
const d = "opacity-0 data-[state=open]:opacity-100";
const e = "opacity-0 group-hover/card:opacity-100 group-data-[active=true]/card:opacity-100";`),
  ).toEqual([]);
});

test("requires state reveals to work without hover", async () => {
  expect(
    await lint(`const a = "opacity-0 hover:opacity-100 hover:data-[state=open]:opacity-100";
const b = "opacity-0 hover:opacity-100 group-hover/row:aria-expanded:opacity-100";
const c = "invisible hover:visible peer-hover:has-[button]:visible";
const d = "opacity-0 hover:opacity-100 data-[state=open]:opacity-100";`),
  ).toEqual([1, 2, 3]);
});

test("requires state reveals to cover the full hide scope", async () => {
  expect(
    await lint(`const a = "opacity-0 hover:opacity-100 md:data-[state=open]:opacity-100";
const b = "opacity-0 hover:opacity-100 data-[state=open]:opacity-100";
const c = "md:opacity-0 md:hover:opacity-100 lg:data-[state=open]:opacity-100";
const d = "md:opacity-0 md:hover:opacity-100 md:data-[state=open]:opacity-100";
const e = "opacity-0 hover:opacity-100 focus-visible:data-[state=open]:opacity-100";
const f = "md:dark:opacity-0 md:dark:hover:opacity-100 md:data-[state=open]:opacity-100";
const g = "md:opacity-0 md:hover:opacity-100 md:dark:data-[state=open]:opacity-100";
const h = "opacity-0 hover:opacity-100 has-[:checked]:opacity-100";
const i = "opacity-0 md:opacity-0 hover:opacity-100 md:data-[state=open]:opacity-100";`),
  ).toEqual([1, 3, 5, 7, 9]);
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

test("requires important touch reveals for important base hides", async () => {
  expect(
    await lint(`const a = "opacity-0! hover:opacity-100! pointer-coarse:opacity-100";
const b = "opacity-0! hover:opacity-100! pointer-coarse:opacity-100!";
const c = "invisible! hover:visible! any-pointer-coarse:visible";
const d = "invisible! hover:visible! any-pointer-coarse:visible!";
const e = "opacity-0 hover:opacity-100 pointer-coarse:opacity-100!";`),
  ).toEqual([1, 3]);
});

test("matches state reveals to every hidden property", async () => {
  expect(
    await lint(`const a = "opacity-0 invisible hover:opacity-100 hover:visible data-[state=open]:opacity-100";
const b = "opacity-0 invisible hover:opacity-100 hover:visible data-[state=open]:visible";
const c = "opacity-0 invisible hover:opacity-100 hover:visible data-[state=open]:opacity-100 data-[state=open]:visible";
const d = "opacity-0 invisible hover:opacity-100 hover:visible data-[state=open]:opacity-100 pointer-coarse:visible";
const e = "opacity-0! hover:opacity-100! data-[state=open]:opacity-100";
const f = "opacity-0! hover:opacity-100! data-[state=open]:opacity-100!";`),
  ).toEqual([1, 2, 5]);
});

test("requires touch decisions for breakpoint hides and hover selectors", async () => {
  expect(
    await lint(`const a = "md:opacity-0 md:group-hover:opacity-100";
const b = "opacity-0 hover:opacity-100 has-[:hover]:opacity-100";
const c = "opacity-0 hover:opacity-100 group-has-[:hover]/row:opacity-100";
const d = "opacity-0 hover:opacity-100 has-[[aria-expanded=true]]:opacity-100";
const e = "md:opacity-0 md:group-hover:opacity-100 pointer-coarse:opacity-100";
const f = "opacity-0 has-[:hover]:opacity-100";`),
  ).toEqual([1, 2, 3, 6]);
});

test("checks unconditional class arguments together without borrowing conditional reveals", async () => {
  expect(
    await lint(`const a = <button className={cn("opacity-0", "group-hover/header:opacity-100")} />;
const b = <button className={cn("opacity-0", "hover:opacity-100", "pointer-coarse:opacity-100")} />;
const c = <button className={cn("opacity-0", "hover:opacity-100", active && "pointer-coarse:opacity-100")} />;
const d = <span aria-hidden="true" className={cn("opacity-0", "hover:opacity-100")} />;
const e = <ChevronIcon className={cn("opacity-0", "hover:opacity-100")} />;`),
  ).toEqual([1, 3]);
});

test("accepts decoration but not an overlay that takes the pointer", async () => {
  expect(
    await lint(`export const a = () => <span aria-hidden="true" className="opacity-0 group-hover:opacity-100" />;
export const b = () => <ChevronIcon className="opacity-0 group-hover:opacity-100" />;
const c = "pointer-events-none opacity-0 group-hover/row:opacity-100";
const d = "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100";`),
  ).toEqual([4]);
});

test("checks template parts and decoration boundaries", async () => {
  expect(
    await lint(
      `const a = \`opacity-0 \${extra} hover:opacity-100\`;\n` +
        `const b = <button className={\`opacity-0 \${extra} hover:opacity-100\`} />;\n` +
        'const c = <span aria-hidden className={cn("opacity-0", "hover:opacity-100")} />;\n' +
        'const d = <span aria-hidden={true} className="opacity-0 hover:opacity-100" />;\n' +
        'const e = <span aria-hidden>{"opacity-0 hover:opacity-100"}</span>;\n' +
        'const f = <button className={cn(active && "opacity-0 hover:opacity-100")} />;',
    ),
  ).toEqual([1, 2, 5, 6]);
});
