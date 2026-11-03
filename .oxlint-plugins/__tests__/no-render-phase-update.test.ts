import { expect, test } from "bun:test";

import { NO_RENDER_PHASE_UPDATE_GOVERNED_PATHS } from "../../oxlint.config.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-render-phase-update";
const CENSUS_PATHS = ["apps", "packages"] as const;

test("the render-phase update census covers every governed path", () => {
  expect(CENSUS_PATHS).toEqual(NO_RENDER_PHASE_UPDATE_GOVERNED_PATHS);
});

test("rejects state updates and navigation in component and hook render bodies", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function Page() { const [value, setValue] = useState(0); setValue(1); navigate({ to: '/next' }); router.navigate({ to: '/next' }); history.replace('/next'); throw redirect({ to: '/next' }); }",
        "function useCurrent() { const [, dispatch] = useReducer(reducer, 0); dispatch({ type: 'reset' }); }",
      ].join("\n"),
    ),
  ).toEqual([1, 1, 1, 1, 1, 2]);
});

test("allows callbacks, route handlers, and guarded render adjustments", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function Page({ value }) { const [prev, setPrev] = useState(value); const [state, setState] = useState(0); if (prev !== value) { setPrev(value); } return <button onClick={() => { setState(1); navigate({ to: '/next' }); }} />; }",
        "createFileRoute('/')({ beforeLoad: () => { throw redirect({ to: '/next' }); }, loader: () => redirect({ to: '/other' }) });",
      ].join("\n"),
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("reports an adjustment in the guard's else branch", async () => {
  expect(
    await lintSingleRule(
      RULE,
      "function Page({ value }) { const [prev, setPrev] = useState(value); if (prev !== value) { setPrev(value); } else { setPrev(value + 1); } }",
    ),
  ).toEqual([1]);
});

test("distinguishes same-named setter bindings between components", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function Stateful() { const [value, setValue] = useState(0); setValue(1); }",
        "function Stateless({ setValue }) { setValue(1); }",
      ].join("\n"),
    ),
  ).toEqual([1]);
});

test("allows a shadowed setter inside a nested function", async () => {
  expect(
    await lintSingleRule(
      RULE,
      "function Page() { const [value, setValue] = useState(0); function update(setValue) { setValue(value + 1); } return update; }",
    ),
  ).toEqual([]);
});

test("compares a guard's member keys by what they read", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function List({ values }) { const [prev, setPrev] = useState(values[0]); if (prev !== values[0]) { setPrev(values[1]); } }",
        "function Keys({ values, key }) { const [prev, setPrev] = useState(values.key); if (prev !== values.key) { setPrev(values[key]); } }",
      ].join("\n"),
    ),
  ).toEqual([1, 2]);
});

test("covers wrapped components, namespace hooks and useMemo factories", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        'import * as React from "react";',
        "const Wrapped = memo(() => { const [, setValue] = useState(0); setValue(1); });",
        "const Forwarded = React.forwardRef(function (props, ref) { const [, setValue] = React.useState(0); setValue(1); });",
        "function Memo() { const [, setValue] = useState(0); useMemo(() => setValue(1), []); }",
      ].join("\n"),
    ),
  ).toEqual([2, 3, 4]);
});

test("follows router bindings rather than names", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        'import { redirect as goTo, useNavigate, useRouter } from "@tanstack/react-router";',
        "function Page() { const go = useNavigate(); go({ to: '/next' }); const nav = useRouter(); nav.navigate({ to: '/next' }); throw goTo({ to: '/next' }); }",
        "function Local() { const navigate = (value) => value; navigate(1); }",
      ].join("\n"),
    ),
  ).toEqual([2, 2, 2]);
});
