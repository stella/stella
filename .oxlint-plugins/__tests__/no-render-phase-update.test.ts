import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-render-phase-update";

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
