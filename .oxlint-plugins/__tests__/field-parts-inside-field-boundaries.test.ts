import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const FIELD_IMPORT =
  'import { Field, FieldDescription, FieldControl } from "@stll/ui/field";\n';

const lint = async (source: string) =>
  lintSingleRule("field-parts-inside-field", `${FIELD_IMPORT}${source}`, {
    sourcePath: "source.tsx",
  });

test("leaves named exported function and const components to their external mounting site", async () => {
  for (const source of [
    "export function Hint() { return <section><FieldDescription>hint</FieldDescription></section>; }",
    "export const Hint = () => <section><FieldDescription>hint</FieldDescription></section>;",
    "function Hint() { return <section><FieldDescription>hint</FieldDescription></section>; }\nexport { Hint };",
    "const Hint = function() { return <section><FieldControl /></section>; };\nexport { Hint as SharedHint };",
  ]) {
    expect(await lint(source)).toEqual([]);
  }
});

test("leaves default exported components to their external mounting site", async () => {
  for (const source of [
    "export default function Hint() { return <section><FieldDescription>hint</FieldDescription></section>; }",
    "const Hint = () => <section><FieldDescription>hint</FieldDescription></section>;\nexport default Hint;",
    "function Hint() { return <section><FieldDescription>hint</FieldDescription></section>; }\nconst Shared = Hint;\nexport default Shared;",
    "export default () => <section><FieldDescription>hint</FieldDescription></section>;",
  ]) {
    expect(await lint(source)).toEqual([]);
  }
});

test("does not infer an unmounted local component mounting context", async () => {
  expect(
    await lint(
      "const Hint = () => <section><FieldDescription>hint</FieldDescription></section>;",
    ),
  ).toEqual([]);
});

test("still reports locally mounted exported parts without a Field root", async () => {
  for (const source of [
    "export function Hint() { return <section><FieldDescription>hint</FieldDescription></section>; }\nexport function Page() { return <main><Hint /></main>; }",
    "export const Hint = () => <section><FieldControl /></section>;\nexport default function Page() { return <main><Hint /></main>; }",
    "function Hint() { return <section><FieldDescription>hint</FieldDescription></section>; }\nexport { Hint as SharedHint };\nconst Page = () => <main><Hint /></main>;\nexport default Page;",
  ]) {
    expect(await lint(source)).toEqual([2]);
  }
});

test("accepts exported parts mounted locally under a Field root", async () => {
  expect(
    await lint(
      "export function Hint() { return <section><FieldDescription>hint</FieldDescription></section>; }\nexport function Page() { return <Field><Hint /></Field>; }",
    ),
  ).toEqual([]);
});

test("keeps unrooted local mounts visible when another mount is covered", async () => {
  for (const source of [
    "export function Hint() { return <section><FieldDescription>hint</FieldDescription></section>; }\nexport function Page() { return <main><Field><Hint /></Field><Hint /></main>; }",
    "export function Hint() { return <section><FieldDescription>hint</FieldDescription></section>; }\nexport function Page() { return <main><Hint /><Field><Hint /></Field></main>; }",
  ]) {
    expect(await lint(source)).toEqual([2]);
  }
});

test("accepts local Field wrappers and shared wrappers with an unreadable external body", async () => {
  expect(
    await lint(
      'import { ExternalRow } from "./external-row";\nconst LocalRow = ({ children }) => <Field>{children}</Field>;\nexport function Page() { return <main><LocalRow><FieldDescription /></LocalRow><ExternalRow><FieldControl /></ExternalRow></main>; }',
    ),
  ).toEqual([]);
});

test("retains field import aliases and leaves unrelated part names alone", async () => {
  expect(
    await lintSingleRule(
      "field-parts-inside-field",
      'import { Field as Root, FieldDescription as Description } from "@stll/ui/field";\nimport { FieldControl } from "./other-controls";\nexport const Hint = () => <section><Description /><FieldControl /></section>;\nexport const Page = () => <Root><Hint /></Root>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("reports imported part aliases at known unrooted local mounts", async () => {
  expect(
    await lintSingleRule(
      "field-parts-inside-field",
      'import { FieldDescription as Description } from "@stll/ui/field";\nimport { FieldControl } from "./other-controls";\nexport const Hint = () => <section><Description /><FieldControl /></section>;\nexport const Page = () => <main><Hint /></main>;',
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([3]);
});

test("follows local wrapper mounting paths without exempting their exported entry point", async () => {
  const components =
    "const Hint = () => <section><FieldDescription /></section>;\nconst Row = () => <aside><Hint /></aside>;\n";
  expect(
    await lint(`${components}export const Page = () => <main><Row /></main>;`),
  ).toEqual([2]);
  expect(
    await lint(
      `${components}export const Page = () => <Field><Row /></Field>;`,
    ),
  ).toEqual([]);
});

test("keeps same-named nested components in different scopes apart", async () => {
  // A's Hint is mounted under a Field; B's unrelated Hint is not.
  const source = [
    "export function A() {",
    "  const Hint = () => <section><FieldDescription>a</FieldDescription></section>;",
    "  return <Field><Hint /></Field>;",
    "}",
    "export function B() {",
    "  const Hint = () => <section><FieldDescription>b</FieldDescription></section>;",
    "  return <main><Hint /></main>;",
    "}",
  ].join("\n");
  // Line 1 is the Field import, so B's part sits on line 7.
  expect(await lint(source)).toEqual([7]);
});
