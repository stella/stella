import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "require-frame-loop-cleanup";

test("reports intervals without an owner-side clear", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "export const discarded = () => { setInterval(tick, 10); };",
        "export const kept = () => { const id = setInterval(tick, 10); };",
        "export const selfStopOnly = () => { const id = setInterval(() => { if (done()) clearInterval(id); }, 10); };",
        "export const otherHandle = () => { const id = window.setInterval(tick, 10); return () => clearInterval(other); };",
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("accepts intervals cleared by their owner or handed to the caller", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "export const cleanup = () => { const id = setInterval(tick, 10); return () => clearInterval(id); };",
        "export const factory = () => { const id = globalThis.setInterval(tick, 10); return { stop: () => clearInterval(id) }; };",
        "export const returned = () => setInterval(tick, 10);",
        "export const member = (ref: { current: number }) => { ref.current = setInterval(tick, 10); };",
        "export const memberStop = (ref: { current: number }) => { clearInterval(ref.current); };",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("requires the effect cleanup to clear an interval the effect starts", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "useMountEffect(() => {",
        "  const id = setInterval(() => { if (ready()) clearInterval(id); }, 80);",
        "  const fallback = setTimeout(() => clearInterval(id), 3000);",
        "  return () => clearTimeout(fallback);",
        "});",
        "useExternalSyncEffect(() => {",
        "  const id = setInterval(tick, 80);",
        "  return () => { clearInterval(id); };",
        "}, [value]);",
      ].join("\n"),
    ),
  ).toEqual([2]);
});

test("accepts effect cleanup returned through a function declaration", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "useEffect(() => { const id = setInterval(tick, 10); function cleanup() { clearInterval(id); } return cleanup; }, []);",
        "useMountEffect(() => { let frame = 0; const tick = () => { if (ready()) frame = requestAnimationFrame(tick); }; frame = requestAnimationFrame(tick); function cleanup() { cancelAnimationFrame(frame); } return cleanup; });",
        "useEffect(() => { const id = setInterval(tick, 10); function cleanup() { clearInterval(other); } return cleanup; }, []);",
      ].join("\n"),
    ),
  ).toEqual([3]);
});

test("reports frame loops that reschedule on every frame", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "useMountEffect(() => {",
        "  let raf = 0;",
        "  const tick = () => {",
        "    draw();",
        "    raf = requestAnimationFrame(tick);",
        "  };",
        "  raf = requestAnimationFrame(tick);",
        "  return () => cancelAnimationFrame(raf);",
        "});",
      ].join("\n"),
    ),
  ).toEqual([5]);
});

test("reports unbounded frame loops without an owner cancel", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "export const poll = () => {",
        "  const run = () => {",
        "    if (!ready()) {",
        "      requestAnimationFrame(run);",
        "    }",
        "  };",
        "  requestAnimationFrame(run);",
        "};",
        "export function inline() {",
        "  if (pending()) requestAnimationFrame(() => inline());",
        "}",
      ].join("\n"),
    ),
  ).toEqual([4, 7, 10]);
});

test("requires an effect-started frame loop to cancel in the cleanup", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "useExternalSyncEffect(() => {",
        "  let frame = 0;",
        "  let cleanup = () => {};",
        "  const sync = () => {",
        "    if (editor === null) {",
        "      frame = requestAnimationFrame(sync);",
        "      return;",
        "    }",
        "    apply(editor);",
        "  };",
        "  sync();",
        "  cleanup = () => cancelAnimationFrame(frame);",
        "  return cleanup;",
        "}, [editor]);",
        "useMountEffect(() => {",
        "  let frame = 0;",
        "  const sync = () => {",
        "    if (!ready()) {",
        "      frame = requestAnimationFrame(sync);",
        "    }",
        "  };",
        "  sync();",
        "  const stop = () => cancelAnimationFrame(frame);",
        "  onDone(stop);",
        "});",
      ].join("\n"),
    ),
  ).toEqual([19]);
});

test("accepts bounded retries, one-shot frames and transferred handles", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "export const retry = () => {",
        "  let attempts = 0;",
        "  const run = () => {",
        "    if (found()) return;",
        "    attempts += 1;",
        "    if (attempts < 30) {",
        "      requestAnimationFrame(run);",
        "    }",
        "  };",
        "  requestAnimationFrame(run);",
        "};",
        "export const earlyExit = () => new Promise<void>((resolve) => {",
        "  let frames = 0;",
        "  const poll = () => {",
        "    if (ready() || frames >= 12) { resolve(); return; }",
        "    frames += 1;",
        "    requestAnimationFrame(poll);",
        "  };",
        "  requestAnimationFrame(poll);",
        "});",
        "export const oneShot = () => { requestAnimationFrame(() => focus()); };",
        "export const schedule = (onFrame: (frame: number) => void) => {",
        "  if (done()) return;",
        "  const frame = requestAnimationFrame(() => schedule(onFrame));",
        "  onFrame(frame);",
        "};",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("ignores local functions that shadow the browser timers", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "export const local = (setInterval: (fn: () => void) => number, window: { setInterval: (fn: () => void) => number }) => {",
        "  setInterval(tick);",
        "  window.setInterval(tick);",
        "};",
        "export function requestAnimationFrame(callback: () => void) { callback(); }",
        "export const loop = () => { requestAnimationFrame(loop); };",
      ].join("\n"),
    ),
  ).toEqual([]);
});

for (const callback of [
  "tick",
  "() => tick()",
  "() => { tick(); }",
  "function () { tick(); }",
]) {
  for (const ownership of ["discarded", "retained"]) {
    test(`${ownership} ${callback} kick-offs share their frame loop's ownership check`, async () => {
      const kickOff = `requestAnimationFrame(${callback});`;
      expect(
        await lintSingleRule(
          RULE,
          [
            "useMountEffect(() => {",
            "  let frame = 0;",
            "  const tick = () => {",
            "    if (visible()) frame = requestAnimationFrame(tick);",
            "  };",
            ownership === "retained" ? `  frame = ${kickOff}` : `  ${kickOff}`,
            "  return () => cancelAnimationFrame(frame);",
            "});",
          ].join("\n"),
        ),
      ).toEqual(ownership === "retained" ? [] : [6]);
    });
  }
}

for (const [progress, comparison, bounded] of [
  ["n++", "n < 10", true],
  ["n++", "n <= 10", true],
  ["n++", "n > 0", false],
  ["n++", "n >= 0", false],
  ["n--", "n > -10", true],
  ["n--", "n >= -10", true],
  ["n--", "n < 10", false],
  ["n--", "n <= 10", false],
  ["n += 2", "10 > n", true],
  ["n -= 2", "-10 < n", true],
  ["n += 0", "n < 10", false],
  ["if (ready()) n++", "n < 10", false],
  ["n++; n = 0", "n < 10", false],
  ["n++; n--", "n < 10", false],
  ["n++", "n < limit", false],
  ["n++", "n < Infinity", false],
] as const) {
  test(`retry budget requires monotonic progress: ${progress}; ${comparison}`, async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          "export const retry = () => { let n = 0;",
          `const tick = () => { ${progress};`,
          `if (${comparison}) requestAnimationFrame(tick);`,
          "};",
          "requestAnimationFrame(tick); };",
        ].join("\n"),
      ),
    ).toEqual(bounded ? [] : [3, 5]);
  });
}

for (const [condition, bounded] of [
  ["ready() || n >= 10", true],
  ["ready() && n >= 10", false],
  ["n >= 10 || ready()", true],
  ["n >= 10 && ready()", false],
  ["!(n < 10)", true],
  ["ready() || (other() && n >= 10)", false],
  ["ready() && (other() || n >= 10)", false],
] as const) {
  test(`early exit must bound every continuing path: ${condition}`, async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          "export const retry = () => { let n = 0;",
          `const tick = () => { if (${condition}) return; n++;`,
          "requestAnimationFrame(tick);",
          "};",
          "requestAnimationFrame(tick); };",
        ].join("\n"),
      ),
    ).toEqual(bounded ? [] : [3, 5]);
  });
}

for (const guard of [
  "if (n >= 10) { if (ready()) return; }",
  "if (n < 10) {} else if (ready()) return;",
]) {
  test(`conditional return does not establish a retry budget: ${guard}`, async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          "export const retry = () => { let n = 0;",
          `const tick = () => { ${guard} n++;`,
          "requestAnimationFrame(tick);",
          "};",
          "requestAnimationFrame(tick); };",
        ].join("\n"),
      ),
    ).toEqual([3, 5]);
  });
}

test("accepts immediate native timer close while requiring ownership for unref and refresh", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "setInterval(tick, 10).close();",
        "setInterval(tick, 10).unref();",
        "setInterval(tick, 10).refresh();",
        "setInterval(tick, 10).close;",
        "setInterval(tick, 10)[close]();",
        "setInterval(tick, 10).close?.();",
      ].join("\n"),
    ),
  ).toEqual([2, 3, 4, 5, 6]);
});

for (const condition of ["n < LIMIT", "LIMIT > n"]) {
  test(`a stable numeric retry limit can appear on either side: ${condition}`, async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          "const LIMIT = 12; export const retry = () => { let n = 0;",
          `const tick = () => { n++; if (${condition}) requestAnimationFrame(tick); };`,
          "requestAnimationFrame(tick); };",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
}

for (const [schedule, bounded] of [
  ["n < 10 && requestAnimationFrame(tick)", true],
  ["n >= 10 || requestAnimationFrame(tick)", true],
  ["n >= 0 && requestAnimationFrame(tick)", false],
  ["n < 10 || requestAnimationFrame(tick)", false],
  ["n < 10 ? requestAnimationFrame(tick) : undefined", true],
  ["n >= 10 ? undefined : requestAnimationFrame(tick)", true],
  ["n < 10 ? undefined : requestAnimationFrame(tick)", false],
  ["while (true) { if (n < 10) requestAnimationFrame(tick); }", false],
] as const) {
  test(`every reschedule path must reach its counter limit: ${schedule}`, async () => {
    expect(
      await lintSingleRule(
        RULE,
        [
          "export const retry = () => { let n = 0; const tick = () => { n++;",
          `${schedule};`,
          "};",
          "requestAnimationFrame(tick); };",
        ].join("\n"),
      ),
    ).toEqual(bounded ? [] : [2, 4]);
  });
}

test("effect ownership follows invoked cleanup helpers, not dormant closures", async () => {
  const dormant = [
    "const unused = () => clearInterval(id);",
    "function unused() { clearInterval(id); }",
    "const stop = () => clearInterval(id); const unused = () => stop();",
  ];
  const invoked = [
    "const stop = () => clearInterval(id); stop();",
    "const stop = () => clearInterval(id); const forward = () => stop(); forward();",
    "(() => clearInterval(id))();",
    "function stop() { clearInterval(id); } stop();",
  ];
  const results = await Promise.all([
    ...dormant.map(async (body) =>
      lintSingleRule(
        RULE,
        `useEffect(() => { const id = setInterval(tick, 10); return () => { ${body} }; }, []);`,
      ),
    ),
    ...invoked.map(async (body) =>
      lintSingleRule(
        RULE,
        `useEffect(() => { const id = setInterval(tick, 10); return () => { ${body} }; }, []);`,
      ),
    ),
    lintSingleRule(
      RULE,
      "useMountEffect(() => { let frame = 0; const tick = () => { if (ready()) frame = requestAnimationFrame(tick); }; frame = requestAnimationFrame(tick); return () => { const unused = () => cancelAnimationFrame(frame); }; });",
    ),
  ]);
  expect(results.slice(0, dormant.length)).toEqual([[1], [1], [1]]);
  expect(results.slice(dormant.length, -1)).toEqual([[], [], [], []]);
  expect(results.at(-1)).not.toEqual([]);
});
