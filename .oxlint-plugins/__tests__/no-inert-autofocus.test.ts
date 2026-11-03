import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  lintSingleRule("no-inert-autofocus", source, { sourcePath: "source.tsx" });

test("rejects autoFocus on intrinsic elements React never focuses", async () => {
  expect(
    await lint("const editor = <div autoFocus contentEditable />;"),
  ).toEqual([1]);
  expect(
    await lint("const pane = <section autoFocus={true} tabIndex={-1} />;"),
  ).toEqual([1]);
});

test("allows the form controls React focuses", async () => {
  expect(
    await lint(
      "const fields = <><input autoFocus /><select autoFocus /><textarea autoFocus /><button autoFocus /></>;",
    ),
  ).toEqual([]);
});

test("leaves components, which may forward the prop, alone", async () => {
  expect(await lint("const field = <Input autoFocus />;")).toEqual([]);
  expect(await lint("const field = <Field.Control autoFocus />;")).toEqual([]);
});
