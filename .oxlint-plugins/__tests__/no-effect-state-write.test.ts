import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-effect-state-write";

test("rejects setters called synchronously in effect bodies, wrappers included", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function A({ v }) { const [x, setX] = useState(0); useExternalSyncEffect(() => { setX(v); }, [v]); }",
        "function B() { const [, dispatch] = useReducer(r, 0); useMountEffect(() => { dispatch({ type: 'go' }); }); }",
        "function C({ v }) { const [x, setX] = useState(0); useLayoutEffect(() => { if (v) { setX(v); } }, [v]); }",
        "function D({ v }) { const [x, setX] = useState(0); useEffect(() => setX(v), [v]); }",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("rejects writes in a returned cleanup and inside synchronous runners", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function A() { const [x, setX] = useState(0); useEffect(() => { return () => { setX(0); }; }, []); }",
        "function B() { const [x, setX] = useState(0); useEffect(() => () => setX(0), []); }",
        "function C({ v }) { const [x, setX] = useState(0); useEffect(() => { startTransition(() => { setX(v); }); }, [v]); }",
        "function D({ v }) { const [x, setX] = useState(0); useEffect(() => { flushSync(() => setX(v)); }, [v]); }",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("allows writes from callbacks an external system calls later", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function A() { const [w, setW] = useState(0); useExternalSyncEffect(() => { const o = new ResizeObserver(() => setW(1)); return () => o.disconnect(); }, []); }",
        "function B() { const [w, setW] = useState(0); useEffect(() => { const t = setTimeout(() => setW(1), 10); return () => clearTimeout(t); }, []); }",
        "function C() { const [w, setW] = useState(0); useEffect(() => { void load().then((value) => setW(value)); }, []); }",
        "function D() { const [w, setW] = useState(0); useEffect(() => store.subscribe(() => setW(1)), []); }",
        "function E() { const [w, setW] = useState(0); return <button onClick={() => setW(1)} />; }",
      ].join("\n"),
      { sourcePath: "source.tsx" },
    ),
  ).toEqual([]);
});

test("does not treat a same-named prop or a non-effect hook as a write in an effect", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function A({ setX, v }) { useEffect(() => { setX(v); }, [v]); }",
        "function B({ v }) { const [x, setX] = useState(0); useMemo(() => setX(v), [v]); }",
      ].join("\n"),
    ),
  ).toEqual([]);
});
