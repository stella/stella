import { expect, test } from "bun:test";

import { lintSingleRule, runSingleRule } from "./lint-single-rule.ts";

const RULE = "no-ref-callback-state-write";
const TSX = { sourcePath: "source.tsx" };

test("rejects inline ref functions that write state, cleanups included", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function A() { const [w, setW] = useState(0); return <div ref={(el) => { setW(el?.offsetWidth ?? 0); }} />; }",
        "function B() { const [, dispatch] = useReducer(r, 0); return <div ref={function (el) { if (el) { dispatch({ type: 'go' }); } }} />; }",
        "function C() { const [o, setO] = useState(false); return <div ref={() => () => setO(false)} />; }",
        "function D() { const [s, setS] = useState(new Map()); return <div ref={(el) => { setS((m) => new Map(m).set('a', el)); }} />; }",
      ].join("\n"),
      TSX,
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("rejects writes from observers, listeners and local helpers the ref reaches", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function A() { const [w, setW] = useState(0); return <div ref={(el) => { if (!el) return; const o = new ResizeObserver(() => setW(el.offsetWidth)); o.observe(el); return () => o.disconnect(); }} />; }",
        "function B() { const [w, setW] = useState(0); const update = () => { setW(1); }; const go = () => update(); return <div ref={(el) => { if (el) go(); }} />; }",
        "function C() { const [w, setW] = useState(0); function measure(el) { setW(el.offsetWidth); } return <div ref={(el) => el && measure(el)} />; }",
      ].join("\n"),
      TSX,
    ),
  ).toEqual([1, 2, 3]);
});

test("follows locals, useCallback, composers and hook-returned refs", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function A() { const [w, setW] = useState(0); const measure = (el) => { setW(1); }; return <div ref={measure} />; }",
        "function B() { const [w, setW] = useState(0); const measure = useCallback((el) => { setW(1); }, []); return <div ref={measure} />; }",
        "function C({ r }) { const [w, setW] = useState(0); const own = useComposedRefs(r, (el) => { setW(1); }); return <div ref={own} />; }",
        "function useFit() { const [z, setZ] = useState(1); const update = (el) => setZ(el.clientWidth); return { containerRef: (el) => { if (el) update(el); } }; }",
        "function useFit2() { const [z, setZ] = useState(1); const containerRef = (el) => { setZ(2); }; return [containerRef]; }",
        "function E() { const [w, setW] = useState(0); return <Child panelRef={(el) => { setW(1); }} />; }",
      ].join("\n"),
      TSX,
    ),
  ).toEqual([1, 2, 3, 4, 5, 6]);
});

test("rejects composing refs during render", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function A({ r }) { const own = useRef(null); return <div ref={composeRefs(own, r)} />; }",
        "function B({ r }) { const own = useRef(null); const both = useMemo(() => composeRefs(own, r), [r]); return <div ref={both} />; }",
        "function useC(r) { const own = useRef(null); return mergeRefs(own, r); }",
      ].join("\n"),
      TSX,
    ),
  ).toEqual([1, 2, 3]);
});

test("allows the bare setter, ref objects, non-writing refs and stable composition", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "function A() { const [el, setEl] = useState(null); return <div ref={setEl} />; }",
        "function B({ forwarded }) { const [el, setEl] = useState(null); const own = useComposedRefs(forwarded, setEl); return <div ref={own} />; }",
        "function C() { const nodes = useRef(new Map()); return <div ref={(el) => { if (el) nodes.current.set('a', el); return () => { nodes.current.delete('a'); }; }} />; }",
        "function D() { const [o, setO] = useState(false); return <div ref={(el) => el?.focus()} onClick={() => setO(true)} />; }",
        "function E({ setX }) { return <div ref={(el) => setX(el)} />; }",
        "function F({ forwarded }) { return <div ref={forwarded} />; }",
        "const attach = (a, b) => composeRefs(a, b);",
        "function G() { const [el, setEl] = useState(null); return <div ref={cond ? setEl : undefined} />; }",
      ].join("\n"),
      TSX,
    ),
  ).toEqual([]);
});

test("fixes a wrapper that only forwards the node to a setter", async () => {
  const result = await runSingleRule(
    RULE,
    [
      "function A() { const [el, setEl] = useState(null); return <div ref={(node) => setEl(node)} />; }",
      "function B() { const [el, setEl] = useState(null); return <div ref={(node) => { setEl(node); }} />; }",
    ].join("\n"),
    { ...TSX, fix: true },
  );
  expect(result.source).toBe(
    [
      "function A() { const [el, setEl] = useState(null); return <div ref={setEl} />; }",
      "function B() { const [el, setEl] = useState(null); return <div ref={setEl} />; }",
    ].join("\n"),
  );
});

test("reports a forwarding function declaration without deleting it", async () => {
  const source =
    "function A() { const [el, setEl] = useState(null); function attach(node) { setEl(node); } return <div ref={attach} />; }";
  const result = await runSingleRule(RULE, source, { ...TSX, fix: true });
  expect(result.source).toBe(source);
  expect(result.lines).toEqual([1]);
});
