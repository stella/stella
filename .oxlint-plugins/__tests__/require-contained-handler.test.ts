import { describe, expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

describe("require-contained-handler", () => {
  test("reports handlers on ref tracked containers", async () => {
    expect(
      await lintSingleRule(
        "require-contained-handler",
        "const page = <div ref={barRef} onMouseDown={handle} onClick={event => event.preventDefault()} />;",
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([1, 1]);
  });
  test("reports callback and member refs with unsafe conditional handlers", async () => {
    expect(
      await lintSingleRule(
        "require-contained-handler",
        "const page = <div ref={refs.bar} onClick={active ? containedHandler(barRef, handle) : handle} />;\nconst other = <section ref={node => assign(node)} onFocus={handle} />;",
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([1, 2]);
  });
  test("accepts both helpers and disabled handlers", async () => {
    expect(
      await lintSingleRule(
        "require-contained-handler",
        "const page = <div ref={barRef} onClick={containedEventHandler(handle)} onPointerDown={containedHandler(realRef, handle)} onMouseDown={undefined} onMouseUp={null} />;",
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
  test("accepts leaf controls blur and untracked containers", async () => {
    expect(
      await lintSingleRule(
        "require-contained-handler",
        "const page = <><input ref={inputRef} onClick={handle} /><div ref={barRef} onBlur={handle} /><div onClick={handle} /></>;",
        { sourcePath: "source.tsx" },
      ),
    ).toEqual([]);
  });
});
