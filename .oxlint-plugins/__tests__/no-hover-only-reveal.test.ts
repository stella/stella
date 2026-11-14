import { expect, test } from "bun:test";

import type { HoverRevealExemptionKind } from "../no-hover-only-reveal.ts";
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

const exemptionScopes = [
  { prefix: "", covering: [""] },
  { prefix: "md:", covering: ["", "md:"] },
  { prefix: "lg:", covering: ["", "lg:"] },
  { prefix: "dark:", covering: ["", "dark:"] },
  { prefix: "md:dark:", covering: ["", "md:", "dark:", "md:dark:"] },
  { prefix: "focus-visible:", covering: ["", "focus-visible:"] },
  {
    prefix: "has-[[aria-expanded=true]]:",
    covering: ["", "has-[[aria-expanded=true]]:"],
  },
];

type UtilityExemptionFixture = {
  name: string;
  hide: string;
  show: string;
  decision: string;
};
type ElementExemptionFixture = {
  name: string;
  render: (classes: string) => string;
};
type ExemptionFixtures =
  | {
      type: "utility";
      cases: readonly [UtilityExemptionFixture, ...UtilityExemptionFixture[]];
    }
  | {
      type: "element";
      cases: readonly [ElementExemptionFixture, ...ElementExemptionFixture[]];
    };

const exemptionFixtures = {
  touch: {
    type: "utility",
    cases: [
      {
        name: "touch opacity reveal",
        hide: "opacity-0",
        show: "opacity-100",
        decision: "pointer-coarse:opacity-100",
      },
      {
        name: "any-pointer visibility reveal",
        hide: "invisible",
        show: "visible",
        decision: "any-pointer-coarse:visible",
      },
      {
        name: "important touch reveal",
        hide: "opacity-0!",
        show: "opacity-100!",
        decision: "pointer-coarse:opacity-100!",
      },
      {
        name: "explicit touch display hide",
        hide: "opacity-0",
        show: "opacity-100",
        decision: "pointer-coarse:hidden",
      },
      {
        name: "explicit touch opacity hide",
        hide: "opacity-0",
        show: "opacity-100",
        decision: "pointer-coarse:opacity-0",
      },
      {
        name: "explicit touch visibility hide",
        hide: "invisible",
        show: "visible",
        decision: "pointer-coarse:invisible",
      },
    ],
  },
  state: {
    type: "utility",
    cases: [
      {
        name: "data state reveal",
        hide: "opacity-0",
        show: "opacity-100",
        decision: "data-[state=open]:opacity-100",
      },
      {
        name: "has state reveal",
        hide: "opacity-0",
        show: "opacity-100",
        decision: "has-[:checked]:opacity-100",
      },
      {
        name: "important state reveal",
        hide: "invisible!",
        show: "visible!",
        decision: "aria-expanded:visible!",
      },
    ],
  },
  "pointer-inert": {
    type: "utility",
    cases: [
      {
        name: "pointer-inert decoration",
        hide: "opacity-0",
        show: "opacity-100",
        decision: "pointer-events-none",
      },
    ],
  },
  decoration: {
    type: "element",
    cases: [
      {
        name: "aria-hidden",
        render: (classes) => `<span aria-hidden className="${classes}" />`,
      },
      {
        name: "icon",
        render: (classes) => `<ChevronIcon className="${classes}" />`,
      },
    ],
  },
} as const satisfies Record<HoverRevealExemptionKind, ExemptionFixtures>;

for (const group of Object.values(exemptionFixtures)) {
  switch (group.type) {
    case "utility":
      for (const { name, hide, show, decision } of group.cases) {
        test(`every exemption covers the hide scope: ${name}`, async () => {
          const source: string[] = [];
          const expected: number[] = [];
          for (const hideScope of exemptionScopes) {
            for (const exemptionScope of exemptionScopes) {
              source.push(
                `const c${source.length} = "${hideScope.prefix}${hide} ${hideScope.prefix}hover:${show} ${exemptionScope.prefix}${decision}";`,
              );
              if (!hideScope.covering.includes(exemptionScope.prefix)) {
                expected.push(source.length);
              }
            }
          }
          expect(await lint(source.join("\n"))).toEqual(expected);
        });
      }
      break;
    case "element":
      for (const { name, render } of group.cases) {
        test(`element decoration covers every hide scope: ${name}`, async () => {
          const source = exemptionScopes.map(
            ({ prefix }, index) =>
              `const c${index} = ${render(`${prefix}opacity-0 ${prefix}hover:opacity-100`)};`,
          );
          expect(await lint(source.join("\n"))).toEqual([]);
        });
      }
      break;
    default:
      group satisfies never;
  }
}

test("conditional element decoration does not exempt a hide", async () => {
  const source: string[] = [];
  const expected: number[] = [];
  for (const { prefix } of exemptionScopes) {
    const classes = `${prefix}opacity-0 ${prefix}hover:opacity-100`;
    source.push(
      `const c${source.length} = <span aria-hidden={false} className="${classes}" />;`,
    );
    expected.push(source.length);
    source.push(
      `const c${source.length} = <span aria-hidden={hidden} className="${classes}" />;`,
    );
    expected.push(source.length);
  }
  expect(await lint(source.join("\n"))).toEqual(expected);
});

test("pointer-inert decisions must cover touch without hover", async () => {
  expect(
    await lint(`const a = "opacity-0 hover:opacity-100 md:pointer-events-none";
const b = "opacity-0 hover:opacity-100 hover:pointer-events-none";
const c = "opacity-0 hover:opacity-100 has-[:hover]:pointer-events-none";
const d = "opacity-0 hover:opacity-100 pointer-events-none";
const e = "opacity-0 hover:opacity-100 pointer-events-none hover:pointer-events-auto";`),
  ).toEqual([1, 2, 3, 5]);
});
