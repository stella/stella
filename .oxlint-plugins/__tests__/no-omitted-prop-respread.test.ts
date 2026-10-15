import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("requires omitted props to be pinned after the last spread", async () => {
  expect(
    await lintSingleRule(
      "no-omitted-prop-respread",
      `function Control(props: Omit<Props,"size">) {return <Button size="small" {...props}/>;}`,
      { sourcePath: "component.tsx" },
    ),
  ).toEqual([1]);
});

test("allows an explicit override after the spread", async () => {
  expect(
    await lintSingleRule(
      "no-omitted-prop-respread",
      `function Control(props: Omit<Props,"size">) {return <Button {...props} size="small"/>;}`,
      { sourcePath: "component.tsx" },
    ),
  ).toEqual([]);
});

test("rejects a later spread that can overwrite the override", async () => {
  expect(
    await lintSingleRule(
      "no-omitted-prop-respread",
      `function Control(props: Omit<Props,"size">) {return <Button {...props} size="small" {...props}/>;}`,
      { sourcePath: "component.tsx" },
    ),
  ).toEqual([1]);
});

test("allows removed runtime keys and locally retyped props", async () => {
  expect(
    await lintSingleRule(
      "no-omitted-prop-respread",
      `function Control({size,...props}: Omit<Props,"size">) {return <Button {...props}/>;}
function Other(props: Omit<Props,"size"> & {size?: "small"}) {return <Button {...props}/>;}`,
      { sourcePath: "component.tsx" },
    ),
  ).toEqual([]);
});
