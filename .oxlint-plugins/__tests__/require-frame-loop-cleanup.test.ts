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
        "export const member = (ref: { current: number }) => { ref.current = setInterval(tick, 10); return () => clearInterval(ref.current); };",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("explicit resource declarations dispose their interval handles", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "export const sync = () => { using id = setInterval(tick, 10); };",
        "export const asyncOwner = async () => { await using id = setInterval(tick, 10); };",
        "export const ordinary = () => { const id = setInterval(tick, 10); };",
      ].join("\n"),
    ),
  ).toEqual([3]);
});

test("effects own directly invoked component frame helpers", async () => {
  const cases = [
    ["useMountEffect(() => { tick(); });", false],
    ["useMountEffect(() => { tick(); return stop; });", true],
    ["useMountEffect(() => { tick(); tick(); return stop; });", false],
    ["useMountEffect(() => { tick(); stop(); tick(); return stop; });", true],
    [
      "const twice=()=>{tick();tick();}; useMountEffect(()=>{twice();return stop;});",
      false,
    ],
    ["useMountEffect(()=>{if(ready())tick();else tick();return stop;});", true],
    ["useMountEffect(()=>{for(let i=0;i<2;i++)tick();return stop;});", false],

    ["const alias = tick; useMountEffect(() => { alias(); });", false],
    ["const begin = () => tick(); useMountEffect(() => { begin(); });", false],
    [
      "const begin = () => tick(); useMountEffect(() => { begin(); return stop; });",
      true,
    ],
    ["const unused = () => tick(); useMountEffect(() => {});", true],
  ] as const;
  const results = await Promise.all(
    cases.map(async ([startup]) =>
      lintSingleRule(
        RULE,
        `const Comp = () => { const frame = { current: 0 }; const tick = () => { if (visible()) frame.current = requestAnimationFrame(tick); }; const stop = () => cancelAnimationFrame(frame.current); ${startup} };`,
      ),
    ),
  );
  expect(results.map((lines) => lines.length === 0)).toEqual(
    cases.map(([, owned]) => owned),
  );
});

test("repeated frame starts distinguish one factory instance from distinct allocations", async () => {
  const factory = (starts: string) =>
    `const factory=()=>{const frame={current:0};const tick=()=>{if(visible())frame.current=requestAnimationFrame(tick);};${starts}return()=>cancelAnimationFrame(frame.current);};`;
  const cases = [
    [`${factory("tick();tick();")}useMountEffect(()=>factory());`, false],
    [
      `${factory(
        "tick();",
      )}useMountEffect(()=>{const first=factory();const second=factory();return()=>{first();second();};});`,
      true,
    ],
  ] as const;
  const results = await Promise.all(
    cases.map(
      async ([code]) =>
        (await lintSingleRule(RULE, `const Comp=()=>{${code}};`)).length === 0,
    ),
  );
  expect(results).toEqual(cases.map(([, owned]) => owned));
});

test("effects own invoked component interval helpers", async () => {
  const cases = [
    ["useMountEffect(() => { begin(); });", false],
    ["useMountEffect(() => { begin(); return stop; });", true],
    ["useMountEffect(() => { begin(); begin(); return stop; });", false],
    [
      "const alias = begin; useMountEffect(() => { begin(); alias(); return stop; });",
      false,
    ],
    [
      "const twice = () => { begin(); begin(); }; useMountEffect(() => { twice(); return stop; });",
      false,
    ],
    ["useMountEffect(() => { begin(); stop(); begin(); return stop; });", true],
    [
      "useMountEffect(() => { begin(); if (ready()) stop(); begin(); return stop; });",
      false,
    ],
    [
      "useMountEffect(() => { if (ready()) begin(); else begin(); return stop; });",
      true,
    ],
    [
      "useMountEffect(() => { for (let i=0;i<2;i++) begin(); return stop; });",
      false,
    ],
    ["const alias = begin; useMountEffect(() => { alias(); });", false],
    ["const unused = () => begin(); useMountEffect(() => {});", true],
  ] as const;
  const results = await Promise.all(
    cases.map(async ([startup]) =>
      lintSingleRule(
        RULE,
        `const Comp = () => { const timer = { current: 0 }; const begin = () => { timer.current = setInterval(tick, 10); }; const stop = () => clearInterval(timer.current); ${startup} };`,
      ),
    ),
  );
  expect(results.map((lines) => lines.length === 0)).toEqual(
    cases.map(([, owned]) => owned),
  );
});

test("repeated interval helper proof stays bounded and shared aliases stay shared", async () => {
  const doubling = Array.from(
    { length: 10 },
    (_, index) =>
      `const wrap${index}=()=>{${index === 0 ? "begin" : `wrap${index - 1}`}();${index === 0 ? "begin" : `wrap${index - 1}`}();};`,
  ).join(" ");
  const cases = [
    `const shared={current:0}; const begin=()=>{const timer=shared;timer.current=setInterval(tick,10);}; useMountEffect(()=>{begin();begin();return()=>clearInterval(shared.current);});`,
    `const timer={current:0};const begin=()=>{timer.current=setInterval(tick,10);};${doubling}useMountEffect(()=>{wrap9();return()=>clearInterval(timer.current);});`,
  ];
  const results = await Promise.all(
    cases.map(async (code) =>
      lintSingleRule(RULE, `const Comp=()=>{${code}};`),
    ),
  );
  for (const lines of results) {
    expect(lines.length).toBeGreaterThan(0);
  }
});

test("unrelated effect registrations preserve loop ownership", async () => {
  const layouts = [
    [0, 0],
    [64, 0],
    [0, 64],
    [64, 64],
  ] as const;
  const cases = ["interval", "frame"].flatMap((kind) =>
    [false, true].flatMap((owned) => {
      const setup =
        kind === "interval"
          ? "const timer={current:0};const begin=()=>{timer.current=setInterval(tick,10);};"
          : "let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};";
      const registration =
        kind === "interval"
          ? `useMountEffect(()=>{begin();${owned ? "return()=>clearInterval(timer.current);" : ""}});`
          : `useMountEffect(()=>{frame=requestAnimationFrame(tick);${owned ? "return()=>cancelAnimationFrame(frame);" : ""}});`;
      return layouts.map(([before, after]) => ({
        owned,
        source: `const Comp=()=>{${setup}${"useMountEffect(()=>unrelated());".repeat(before)}${registration}${"useMountEffect(()=>unrelated());".repeat(after)}};`,
      }));
    }),
  );
  const results = await Promise.all(
    cases.map(async ({ source }) => lintSingleRule(RULE, source)),
  );
  expect(results).toEqual(cases.map(({ owned }) => (owned ? [] : [1])));
});

test("unrelated helper graphs do not consume a reachable loop path budget", async () => {
  const noise = Array.from(
    { length: 70 },
    (_, index) =>
      `const noise${index}=()=>${index === 0 ? "unrelated" : `noise${index - 1}`}();`,
  ).join("");
  const setups = [
    `${noise}useMountEffect(()=>noise69());`,
    "const noise0=()=>{if(again())noise1();};const noise1=()=>noise0();useMountEffect(()=>noise0());",
  ];
  const cases = setups.flatMap((unrelated) => [
    `const Comp=()=>{${unrelated}const timer={current:0};const begin=()=>{timer.current=setInterval(tick,10);};useMountEffect(()=>{begin();return()=>clearInterval(timer.current);});};`,
    `const Comp=()=>{${unrelated}let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};useMountEffect(()=>{frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);});};`,
  ]);
  cases.push(
    `const Comp=()=>{${noise}const timer={current:0};const begin=()=>{timer.current=setInterval(tick,10);};useMountEffect(()=>{noise69();begin();return()=>clearInterval(timer.current);});};`,
  );
  const results = await Promise.all(
    cases.map(async (source) => lintSingleRule(RULE, source)),
  );
  expect(results).toEqual(cases.map(() => []));
});

test("reachable loop helper depth still fails closed at the proof limit", async () => {
  const cases = [65, 96].map((depth) => {
    const helpers = Array.from(
      { length: depth },
      (_, index) =>
        `const step${index}=()=>${index === 0 ? "begin" : `step${index - 1}`}();`,
    ).join("");
    return `const Comp=()=>{const timer={current:0};const begin=()=>{timer.current=setInterval(tick,10);};${helpers}useMountEffect(()=>{step${depth - 1}();return()=>clearInterval(timer.current);});};`;
  });
  const results = await Promise.all(
    cases.map(async (source) => lintSingleRule(RULE, source)),
  );
  expect(results.map((lines) => lines.length > 0)).toEqual([true, true]);
});

test("effect-local helpers retain repeated-start ownership checks", async () => {
  const cases = [
    [
      "useMountEffect(()=>{let id;const begin=()=>{id=setInterval(tick,10);};begin();begin();return()=>clearInterval(id);});",
      false,
    ],
    [
      "useMountEffect(()=>{let id;const begin=()=>{clearInterval(id);id=setInterval(tick,10);};begin();begin();return()=>clearInterval(id);});",
      true,
    ],
    [
      "useMountEffect(()=>{let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};tick();tick();return()=>cancelAnimationFrame(frame);});",
      false,
    ],
    [
      "useMountEffect(()=>{let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};tick();cancelAnimationFrame(frame);tick();return()=>cancelAnimationFrame(frame);});",
      true,
    ],
  ] as const;
  const results = await Promise.all(
    cases.map(
      async ([code]) =>
        (await lintSingleRule(RULE, `const Comp=()=>{${code}};`)).length === 0,
    ),
  );
  expect(results).toEqual(cases.map(([, owned]) => owned));
});

test("only mutually exclusive writes can share one cleanup handle", async () => {
  const cases = [
    [
      "let id;if(enabled)id=setInterval(tick,10);else id=setInterval(tick,20);return()=>clearInterval(id);",
      true,
    ],
    [
      "const timer={current:0};if(enabled)timer.current=setInterval(tick,10);else timer.current=setInterval(tick,20);return()=>clearInterval(timer.current);",
      true,
    ],
    [
      "let id;enabled?(id=setInterval(tick,10)):(id=setInterval(tick,20));return()=>clearInterval(id);",
      true,
    ],
    [
      "const timer={current:0};enabled?(timer.current=setInterval(tick,10)):(timer.current=setInterval(tick,20));return()=>clearInterval(timer.current);",
      true,
    ],
    [
      "let id;if(enabled){id=setInterval(tick,10);return()=>clearInterval(id);}id=setInterval(tick,20);return()=>clearInterval(id);",
      true,
    ],
    [
      "const ref={current:0};if(enabled){ref.current=setInterval(tick,10);return()=>clearInterval(ref.current);}ref.current=setInterval(tick,20);return()=>clearInterval(ref.current);",
      true,
    ],
    [
      "let id;if(enabled)id=setInterval(tick,10);id=setInterval(tick,20);return()=>clearInterval(id);",
      false,
    ],
    [
      "const timer={current:0};if(enabled)timer.current=setInterval(tick,10);if(alsoEnabled)timer.current=setInterval(tick,20);return()=>clearInterval(timer.current);",
      false,
    ],
    [
      "let id;const begin=()=>{if(enabled){id=setInterval(tick,10);return;}};begin();id=setInterval(tick,20);return()=>clearInterval(id);",
      false,
    ],
    [
      "const ref={current:0};const begin=()=>{if(enabled){ref.current=setInterval(tick,10);return;}};begin();ref.current=setInterval(tick,20);return()=>clearInterval(ref.current);",
      false,
    ],
  ] as const;
  const results = await Promise.all(
    cases.map(
      async ([code]) =>
        (await lintSingleRule(RULE, `useMountEffect(()=>{${code}});`))
          .length === 0,
    ),
  );
  expect(results).toEqual(cases.map(([, owned]) => owned));
});

test("returning guards preserve ownership across source separators", async () => {
  const results = await Promise.all(
    ["", " ", "\n", "/* next branch */"].flatMap((separator) =>
      ["interval", "frame"].flatMap((kind) =>
        ["id", "ref.current"].map(async (target) => {
          const declaration =
            target === "id" ? "let id;" : "const ref={current:0};";
          const allocate =
            kind === "interval"
              ? "setInterval(tick,10)"
              : "requestAnimationFrame(tick)";
          const cancel =
            kind === "interval" ? "clearInterval" : "cancelAnimationFrame";
          return lintSingleRule(
            RULE,
            `useMountEffect(()=>{${declaration}if(enabled){${target}=${allocate};return()=>${cancel}(${target});}${separator}${target}=${allocate};return()=>${cancel}(${target});});`,
          );
        }),
      ),
    ),
  );
  expect(results).toEqual(results.map(() => []));
});

test("named effect callbacks use the same cleanup ownership proof", async () => {
  const cases = [
    [
      "const ref={current:0};const begin=()=>{ref.current=setInterval(tick,10);};const stop=()=>clearInterval(ref.current);",
      "begin",
      false,
    ],
    [
      "const ref={current:0};const begin=()=>{ref.current=setInterval(tick,10);return()=>clearInterval(ref.current);};",
      "begin",
      true,
    ],
    [
      "function begin(){const id=setInterval(tick,10);return()=>clearInterval(id);}",
      "begin",
      true,
    ],
    [
      "const begin=()=>{const id=setInterval(tick,10);return()=>clearInterval(id);};const alias=begin;",
      "alias",
      true,
    ],
    ["const begin=()=>setInterval(tick,10);", "begin", false],
    [
      "const begin=()=>{const id=setInterval(tick,10);return()=>{const unused=()=>clearInterval(id);};};",
      "begin",
      false,
    ],
    [
      "let id;const start=()=>{id=setInterval(tick,10);};const begin=()=>{start();start();return()=>clearInterval(id);};",
      "begin",
      false,
    ],
    [
      "let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};const begin=()=>{tick();tick();return()=>cancelAnimationFrame(frame);};",
      "begin",
      false,
    ],
    [
      "let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};const begin=()=>{tick();return()=>cancelAnimationFrame(frame);};const alias=begin;",
      "alias",
      true,
    ],
  ] as const;
  const hooks = [
    "useEffect",
    "useExternalSyncEffect",
    "useInsertionEffect",
    "useLayoutEffect",
    "useMountEffect",
    "React.useEffect",
  ];
  const results = await Promise.all(
    hooks.flatMap((hook) =>
      cases.map(async ([setup, callback]) => {
        const effect =
          hook === "useMountEffect"
            ? `${hook}(${callback})`
            : `${hook}(${callback},[])`;
        return (
          (await lintSingleRule(RULE, `const Comp=()=>{${setup}${effect};};`))
            .length === 0
        );
      }),
    ),
  );
  expect(results).toEqual(hooks.flatMap(() => cases.map((entry) => entry[2])));
});

test("effect registrations distinguish shared handles from fresh allocations", async () => {
  const cases = [
    [
      "const ref={current:0};const begin=()=>{ref.current=setInterval(tick,10);return()=>clearInterval(ref.current);};useMountEffect(begin);useMountEffect(begin);",
      false,
    ],
    [
      "const begin=()=>{const id=setInterval(tick,10);return()=>clearInterval(id);};useMountEffect(begin);useMountEffect(begin);",
      true,
    ],
    [
      "const ref={current:0};const begin=()=>{ref.current=setInterval(tick,10);return()=>clearInterval(ref.current);};const alias=begin;useMountEffect(begin);useExternalSyncEffect(alias,[]);",
      false,
    ],
    [
      "const ref={current:0};useMountEffect(()=>{ref.current=setInterval(tick,10);return()=>clearInterval(ref.current);});useMountEffect(()=>{ref.current=setInterval(tick,20);return()=>clearInterval(ref.current);});",
      false,
    ],
    [
      "useMountEffect(()=>{const id=setInterval(tick,10);return()=>clearInterval(id);});useMountEffect(()=>{const id=setInterval(tick,20);return()=>clearInterval(id);});",
      true,
    ],
    [
      "const ref={current:0};const begin=()=>{clearInterval(ref.current);ref.current=setInterval(tick,10);return()=>clearInterval(ref.current);};useMountEffect(begin);useMountEffect(begin);",
      true,
    ],
    [
      "const frame={current:0};const tick=()=>{if(visible())frame.current=requestAnimationFrame(tick);};const begin=()=>{tick();return()=>cancelAnimationFrame(frame.current);};useMountEffect(begin);useMountEffect(begin);",
      false,
    ],
    [
      "const begin=()=>{const frame={current:0};const tick=()=>{if(visible())frame.current=requestAnimationFrame(tick);};tick();return()=>cancelAnimationFrame(frame.current);};useMountEffect(begin);useMountEffect(begin);",
      true,
    ],
    [
      "const frame={current:0};const begin=()=>{const tick=()=>{if(visible())frame.current=requestAnimationFrame(tick);};frame.current=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame.current);};useMountEffect(begin);useMountEffect(begin);",
      false,
    ],
    [
      "const begin=()=>{const frame={current:0};const tick=()=>{if(visible())frame.current=requestAnimationFrame(tick);};frame.current=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame.current);};useMountEffect(begin);useMountEffect(begin);",
      true,
    ],
    [
      "const factory=()=>{const frame={current:0};const tick=()=>{if(visible())frame.current=requestAnimationFrame(tick);};frame.current=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame.current);};useMountEffect(()=>{factory();});",
      false,
    ],
    [
      "const factory=()=>{const frame={current:0};const tick=()=>{if(visible())frame.current=requestAnimationFrame(tick);};frame.current=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame.current);};useMountEffect(()=>{factory();return factory();});",
      false,
    ],
    [
      "const factory=()=>{const frame={current:0};const tick=()=>{if(visible())frame.current=requestAnimationFrame(tick);};frame.current=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame.current);};useMountEffect(()=>{const first=factory();const second=factory();return()=>{first();second();};});",
      true,
    ],
  ] as const;
  const results = await Promise.all(
    cases.map(
      async ([code]) =>
        (await lintSingleRule(RULE, `const Comp=()=>{${code}};`)).length === 0,
    ),
  );
  expect(results).toEqual(cases.map(([, owned]) => owned));
});

test("source-only factories retain their contract without inheriting lexical effects", async () => {
  const intervalFactory =
    "const factory=()=>{const id=setInterval(tick,10);return()=>clearInterval(id);};";
  const frameFactory =
    "const factory=()=>{const frame={current:0};const tick=()=>{if(visible())frame.current=requestAnimationFrame(tick);};frame.current=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame.current);};";
  const cases = [
    [intervalFactory, true],
    [`useMountEffect(()=>{${intervalFactory}});`, true],
    [`useMountEffect(()=>{${intervalFactory}factory();});`, false],
    [`useMountEffect(()=>{${intervalFactory}return factory();});`, true],
    [frameFactory, true],
    [`useMountEffect(()=>{${frameFactory}});`, true],
    [`useMountEffect(()=>{${frameFactory}factory();});`, false],
    [`useMountEffect(()=>{${frameFactory}return factory();});`, true],
    [
      "useMountEffect(()=>{let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);});",
      true,
    ],
    [
      "useMountEffect(()=>{let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);});",
      false,
    ],
    [
      "useMountEffect(()=>{let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);});",
      false,
    ],
    [
      "const begin=()=>{let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);};useMountEffect(begin);",
      true,
    ],
    [
      "const begin=()=>{let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);};useMountEffect(begin);",
      false,
    ],
  ] as const;
  const results = await Promise.all(
    cases.map(
      async ([code]) => (await lintSingleRule(RULE, code)).length === 0,
    ),
  );
  expect(results).toEqual(cases.map(([, owned]) => owned));
});

test("effect factories transfer their actual result into cleanup ownership", async () => {
  const cases = [
    [
      "const begin=()=>setInterval(tick,10);useMountEffect(()=>{begin();});",
      false,
    ],
    [
      "const begin=()=>setInterval(tick,10);useMountEffect(()=>begin());",
      false,
    ],
    [
      "const begin=()=>setInterval(tick,10);useMountEffect(()=>{const id=begin();return()=>clearInterval(id);});",
      true,
    ],
    [
      "const begin=()=>{return setInterval(tick,10);};useMountEffect(()=>{const id=begin();return()=>clearInterval(id);});",
      true,
    ],
    [
      "const begin=()=>{const id=setInterval(tick,10);const result=id;return result;};useMountEffect(()=>{const id=begin();return()=>clearInterval(id);});",
      true,
    ],
    [
      "const begin=()=>setInterval(tick,10);useMountEffect(()=>{register(begin());});",
      true,
    ],
    [
      "const begin=()=>setInterval(tick,10);const wrap=()=>{begin();};useMountEffect(()=>{const id=wrap();return()=>clearInterval(id);});",
      false,
    ],
    [
      "const begin=()=>setInterval(tick,10);const wrap=()=>{begin();return 0;};useMountEffect(()=>{const id=wrap();return()=>clearInterval(id);});",
      false,
    ],
    [
      "const begin=()=>setInterval(tick,10);const wrap=()=>{const id=begin();if(ready())return id;return 0;};useMountEffect(()=>{const id=wrap();return()=>clearInterval(id);});",
      false,
    ],
    [
      "const begin=()=>setInterval(tick,10);const alias=begin;const wrap=()=>{const id=alias();const result=id;return result;};useMountEffect(()=>{const id=wrap();return()=>clearInterval(id);});",
      true,
    ],
    [
      "const begin=()=>{const id=setInterval(tick,10);return()=>clearInterval(id);};useMountEffect(()=>begin());",
      true,
    ],
    [
      "const begin=()=>{const id=setInterval(tick,10);return()=>clearInterval(id);};useMountEffect(()=>{return begin();});",
      true,
    ],
    [
      "const begin=()=>{const id=setInterval(tick,10);return()=>clearInterval(id);};useMountEffect(()=>{const stop=begin();return stop;});",
      true,
    ],
    [
      "const begin=()=>{const id=setInterval(tick,10);return()=>clearInterval(id);};useMountEffect(()=>{begin();});",
      false,
    ],
    [
      "const begin=()=>{const id=setInterval(tick,10);if(ready())return()=>clearInterval(id);};useMountEffect(()=>begin());",
      false,
    ],
    [
      "const begin=()=>{const id=setInterval(tick,10);return()=>{const unused=()=>clearInterval(id);};};useMountEffect(()=>begin());",
      false,
    ],
  ] as const;
  const results = await Promise.all(
    cases.map(
      async ([code]) =>
        (await lintSingleRule(RULE, `const Comp=()=>{${code}};`)).length === 0,
    ),
  );
  expect(results).toEqual(cases.map(([, owned]) => owned));
});

test("factory cleanups cancel only the allocation that produced their result", async () => {
  const factory =
    "const factory=()=>{const id=setInterval(tick,10);return()=>clearInterval(id);};";
  const cases = [
    [`${factory}useMountEffect(()=>{factory();return factory();});`, false],
    [
      `${factory}useMountEffect(()=>{const first=factory();const second=factory();return()=>second();});`,
      false,
    ],
    [
      `${factory}useMountEffect(()=>{const first=factory();const second=factory();return()=>{first();second();};});`,
      true,
    ],
    [
      `${factory}const wrap=()=>factory();useMountEffect(()=>{wrap();return wrap();});`,
      false,
    ],
    [
      `${factory}const wrap=()=>factory();useMountEffect(()=>{const first=wrap();const second=wrap();return()=>{first();second();};});`,
      true,
    ],
    [`useMountEffect(()=>{${factory}factory();return factory();});`, false],
  ] as const;
  const results = await Promise.all(
    cases.map(
      async ([code]) =>
        (await lintSingleRule(RULE, `const Comp=()=>{${code}};`)).length === 0,
    ),
  );
  expect(results).toEqual(cases.map(([, owned]) => owned));
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

test("inline frame callbacks retain guards on every recursive invocation", async () => {
  const cases = [
    ["if (visible()) tick();", true],
    ["if (!visible()) return; tick();", true],
    ["const unused = () => tick(); draw();", true],
    ["const unused = () => tick(); if (visible()) tick();", true],
    ["tick();", false],
    ["if (visible()) draw(); tick();", false],
    ["if (visible()) tick(); tick();", false],
  ] as const;
  const results = await Promise.all(
    cases.map(async ([body]) =>
      lintSingleRule(
        RULE,
        `useMountEffect(() => { let frame = 0; const tick = () => { frame = requestAnimationFrame(() => { ${body} }); }; tick(); return () => cancelAnimationFrame(frame); });`,
      ),
    ),
  );
  expect(results.map((lines) => lines.length === 0)).toEqual(
    cases.map(([, guarded]) => guarded),
  );
});

test("requires an effect-started frame loop to cancel in the cleanup", async () => {
  expect(
    await lintSingleRule(
      RULE,
      [
        "useExternalSyncEffect(() => {",
        "  let frame = 0;",
        "  const cleanup = () => cancelAnimationFrame(frame);",
        "  const sync = () => {",
        "    if (editor === null) {",
        "      frame = requestAnimationFrame(sync);",
        "      return;",
        "    }",
        "    apply(editor);",
        "  };",
        "  sync();",
        "",
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

test("an owned kickoff cannot hide another discarded kickoff of the same loop", async () => {
  const results = await Promise.all(
    [false, true].map(async (ownedFirst) => {
      const setup = [
        "useMountEffect(() => {",
        "  let frame = 0;",
        "  const tick = () => {",
        "    if (visible()) frame = requestAnimationFrame(tick);",
        "  };",
      ];
      const owned = [
        "  frame = requestAnimationFrame(tick);",
        "  cancelAnimationFrame(frame);",
      ];
      const discarded = "  requestAnimationFrame(tick);";
      const starts = ownedFirst ? [...owned, discarded] : [discarded, ...owned];
      return await lintSingleRule(
        RULE,
        [
          ...setup,
          ...starts,
          "  return () => cancelAnimationFrame(frame);",
          "});",
        ].join("\n"),
      );
    }),
  );
  expect(results).toEqual([[6], [8]]);
});

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

test("effect setup cancellation must execute after creation", async () => {
  const cases = [
    ["const id=setInterval(tick,10);clearInterval(id);", true],
    [
      "const ref={current:0};ref.current=setInterval(tick,10);clearInterval(ref.current);",
      true,
    ],
    [
      "const id=setInterval(tick,10);const stop=()=>clearInterval(id);stop();",
      true,
    ],
    ["const id=setInterval(tick,10);if(ready())clearInterval(id);", false],
    [
      "const id=setInterval(tick,10);const unused=()=>clearInterval(id);",
      false,
    ],
    ["let id;clearInterval(id);id=setInterval(tick,10);", false],
    [
      "let id;const stop=()=>clearInterval(id);stop();id=setInterval(tick,10);",
      false,
    ],
    [
      "const id=setInterval(tick,10);setTimeout(()=>clearInterval(id),10);",
      false,
    ],
    [
      "const begin=()=>{const id=setInterval(tick,10);return()=>clearInterval(id);};begin();",
      false,
    ],
    [
      "const begin=()=>{const id=setInterval(tick,10);return()=>clearInterval(id);};begin();const stop=begin();stop();",
      false,
    ],
    [
      "let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};tick();cancelAnimationFrame(frame);",
      true,
    ],
    [
      "let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);cancelAnimationFrame(frame);",
      true,
    ],
    [
      "let frame=0;const tick=()=>{if(visible())frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);if(ready())cancelAnimationFrame(frame);",
      false,
    ],
  ] as const;
  const registrations = [
    (body: string) => `useMountEffect(()=>{${body}});`,
    (body: string) =>
      `const beginEffect=()=>{${body}};useEffect(beginEffect,[]);`,
    (body: string) =>
      `function beginEffect(){${body}}useExternalSyncEffect(beginEffect,[]);`,
  ];
  const results = await Promise.all(
    cases.flatMap(([body, owned]) =>
      registrations.map(async (registration) => [
        (await lintSingleRule(RULE, registration(body))).length === 0,
        owned,
      ]),
    ),
  );
  expect(results.map(([actual]) => actual)).toEqual(
    results.map(([, owned]) => owned),
  );
});

test("effect cleanup ownership covers every reachable path and immutable alias", async () => {
  const cases = [
    [
      "let cleanup = () => clearInterval(id); cleanup = () => {}; return cleanup;",
      false,
    ],
    [
      "function cleanup() { clearInterval(id); } cleanup = () => {}; return cleanup;",
      false,
    ],
    [
      "let stop = () => clearInterval(id); stop = () => {}; return () => stop();",
      false,
    ],
    [
      "let stop = () => clearInterval(id); const alias = stop; stop = () => {}; return alias;",
      false,
    ],
    [
      "let cleanup = () => {}; if (ready()) cleanup = () => clearInterval(id); return cleanup;",
      false,
    ],
    [
      "const stop = () => clearInterval(id); const alias = stop; return alias;",
      true,
    ],
    [
      "function stop() { clearInterval(id); } const alias = stop; return () => alias();",
      true,
    ],
    ["if (ready()) return () => {}; return () => clearInterval(id);", false],
    ["if (ready()) return; return () => clearInterval(id);", false],
    ["if (ready()) return () => clearInterval(id);", false],
    ["if (ready()) return () => clearInterval(id); else throw failure;", false],
    [
      "if (ready()) return () => clearInterval(id); return () => clearInterval(id);",
      true,
    ],
    ["return () => { if (ready()) clearInterval(id); };", false],
    ["return () => { if (ready()) return; clearInterval(id); };", false],
    [
      "return () => { if (ready()) clearInterval(id); else clearInterval(id); };",
      true,
    ],
    [
      "return () => { if (ready()) { clearInterval(id); return; } clearInterval(id); };",
      true,
    ],
    ["return () => { if (!id) return; clearInterval(id); };", true],
    ["return () => id && clearInterval(id);", true],
    ["return () => { if (id !== 0) clearInterval(id); };", true],
    ["return () => ready() && clearInterval(id);", false],
    ["const unused = () => consume(id); return () => {};", false],
    ["return () => { const unused = () => consume(id); };", false],
    ["return () => { if (ready()) consume(id); };", false],
    ["return () => consume(id);", true],
    ["return id;", false],
    ["consume(id); return () => {};", true],
    ["if (ready()) consume(id); return () => {};", false],
    ["return () => ready() ? clearInterval(id) : undefined;", false],
    ["return () => { while (ready()) clearInterval(id); };", false],
    [
      "return () => { try { throw failure; } finally { clearInterval(id); } };",
      true,
    ],
    [
      "return () => { try { throw failure; } catch { clearInterval(id); } };",
      true,
    ],
    [
      "return () => { try { if (ready()) return; } finally { clearInterval(id); } };",
      true,
    ],
    [
      "return () => { try { while (true) {} } finally { clearInterval(id); } };",
      false,
    ],
    [
      "return () => { function stop() { return; } stop(); clearInterval(id); };",
      true,
    ],
    [
      "return () => { function stop() { throw failure; } stop(); clearInterval(id); };",
      false,
    ],
    [
      "return () => { function stop() { stop(); clearInterval(id); } stop(); };",
      false,
    ],
    ["function* cleanup() { clearInterval(id); } return cleanup;", false],
    ["return async () => { await wait(); clearInterval(id); };", false],
    ["return async () => { clearInterval(id); await wait(); };", true],
    [
      "return () => { async function flush() { await wait(); } flush(); clearInterval(id); };",
      true,
    ],
    [
      "return () => { async function flush() { throw failure; } flush(); clearInterval(id); };",
      true,
    ],
    [
      "const stop = () => clearInterval(id); return () => { const unused = () => stop(); };",
      false,
    ],
  ] as const;
  const results = await Promise.all(
    cases.map(async ([body]) =>
      lintSingleRule(
        RULE,
        `useEffect(() => { const id = setInterval(tick, 10); ${body} }, []);`,
      ),
    ),
  );
  expect(results.map((lines) => lines.length === 0)).toEqual(
    cases.map(([, owned]) => owned),
  );
});

test("outside-effect handoffs must execute after timer creation", async () => {
  const cases = [
    ["consume(id);", true],
    ["if (ready()) consume(id);", false],
    ["const unused = () => consume(id);", false],
    ["function unused() { consume(id); }", false],
    ["const unused = () => clearInterval(id);", false],
    ["return { stop: () => clearInterval(id) };", true],
    ["return () => clearInterval(id);", true],
    ["return id;", true],
    ["const handoff = () => consume(id); handoff();", true],
  ] as const;
  const results = await Promise.all(
    cases.map(async ([handoff]) =>
      lintSingleRule(
        RULE,
        `const owner = () => { const id = setInterval(tick, 10); ${handoff} };`,
      ),
    ),
  );
  expect(results.map((lines) => lines.length === 0)).toEqual(
    cases.map(([, owned]) => owned),
  );
});

test("member handles retain one stable root and an unambiguous pending timer", async () => {
  const sources = [
    "useEffect(() => { ref.current = setInterval(tick, 10); ref.current = setInterval(tick, 20); return () => clearInterval(ref.current); }, []);",
    "useEffect(() => { ref.current = setInterval(tick, 10); ref.current = undefined; return () => clearInterval(ref.current); }, []);",
    "useEffect(() => { const alias = ref; ref.current = setInterval(tick, 10); alias.current = setInterval(tick, 20); return () => clearInterval(ref.current); }, []);",
    "useEffect(() => { ref.current = setInterval(tick, 10); return () => { const ref = { current: 0 }; clearInterval(ref.current); }; }, []);",
  ];
  const results = await Promise.all(
    sources.map(async (source) =>
      lintSingleRule(
        RULE,
        `const Comp = () => { const ref = { current: 0 }; ${source} };`,
      ),
    ),
  );
  expect(results.map((lines) => lines.length > 0)).toEqual(
    sources.map(() => true),
  );
});

test("replacing a timer requires executed cancellation of the previous handle", async () => {
  const cases = [
    ["clearInterval(id); id = setInterval(tick, 20);", true],
    [
      "const stop = () => clearInterval(id); stop(); id = setInterval(tick, 20);",
      true,
    ],
    ["if (ready()) clearInterval(id); id = setInterval(tick, 20);", false],
    [
      "const unused = () => clearInterval(id); id = setInterval(tick, 20);",
      false,
    ],
    [
      "clearInterval(id); id = setInterval(tick, 20); id = setInterval(tick, 30);",
      false,
    ],
    ["for (let i = 0; i < 2; i++) id = setInterval(tick, 20);", false],
    [
      "for (let i = 0; i < 2; i++) { clearInterval(id); id = setInterval(tick, 20); }",
      true,
    ],
  ] as const;
  for (const member of [false, true]) {
    const results = await Promise.all(
      cases.map(async ([body]) =>
        lintSingleRule(
          RULE,
          `useEffect(() => { ${member ? "const ref = { current: 0 }; ref.current" : "let id"} = setInterval(tick, 10); ${member ? body.replaceAll("id", "ref.current") : body} return () => clearInterval(${member ? "ref.current" : "id"}); }, []);`,
        ),
      ),
    );
    expect(results.map((lines) => lines.length === 0)).toEqual(
      cases.map(([, owned]) => owned),
    );
  }
});

test("setup loops require proven termination and cleanup on every exit", async () => {
  const cases = [
    ["for(let n=0;n<2;n++){clearInterval(id);id=setInterval(tick,20);}", true],
    ["for(let n=2;n>0;n--){clearInterval(id);id=setInterval(tick,20);}", true],
    ["for(let n=0;3>n;n+=2){clearInterval(id);id=setInterval(tick,20);}", true],
    [
      "const limit=2;for(let n=0;n<limit;n++){clearInterval(id);id=setInterval(tick,20);}",
      true,
    ],
    [
      "for(let n=0;n<2;n++){if(ready())clearInterval(id);id=setInterval(tick,20);}",
      false,
    ],
    [
      "for(let n=0;n<2;n++){clearInterval(id);id=setInterval(tick,20);if(ready())return;}",
      false,
    ],
    [
      "for(let n=0;n<2;n++){clearInterval(id);id=setInterval(tick,20);throw failure;}",
      false,
    ],
    [
      "for(let n=0;n<2;n++){clearInterval(id);id=setInterval(tick,20);n=0;}",
      false,
    ],
    ["for(let n=0;n<2;n--){clearInterval(id);id=setInterval(tick,20);}", false],
    [
      "for(let n=0;n<Infinity;n++){clearInterval(id);id=setInterval(tick,20);}",
      false,
    ],
    ["for(;;){}", false],
    ["while(true){}", false],
    ["while(ready()){clearInterval(id);id=setInterval(tick,20);}", false],
    ["do{clearInterval(id);id=setInterval(tick,20);}while(ready());", false],
    [
      "for(let n=0;n<2;n++){clearInterval(id);id=setInterval(tick,20);}return;",
      false,
    ],
  ] as const;
  const results = await Promise.all(
    cases.flatMap(([body, owned]) =>
      [false, true].map(async (member) => {
        const target = member ? "ref.current" : "id";
        const declaration = member
          ? "const ref={current:0};ref.current=setInterval(tick,10);"
          : "let id=setInterval(tick,10);";
        const source = `useEffect(()=>{${declaration}${body.replaceAll("id", () => target)}return()=>clearInterval(${target});},[]);`;
        return [(await lintSingleRule(RULE, source)).length === 0, owned];
      }),
    ),
  );
  expect(results.map(([actual]) => actual)).toEqual(
    results.map(([, owned]) => owned),
  );
});

test("cancellation must execute after creation, independent of helper declaration order", async () => {
  const cases = [
    ["let id; clearInterval(id); id = setInterval(tick, 10);", false],
    ["let id; id = setInterval(tick, 10); clearInterval(id);", true],
    [
      "let id; stop(); id = setInterval(tick, 10); function stop() { clearInterval(id); }",
      false,
    ],
    [
      "let id; id = setInterval(tick, 10); stop(); function stop() { clearInterval(id); }",
      true,
    ],
    [
      "let id; function stop() { clearInterval(id); } stop(); id = setInterval(tick, 10);",
      false,
    ],
    [
      "let id; function stop() { clearInterval(id); } id = setInterval(tick, 10); stop();",
      true,
    ],
    [
      "let id; function stop() { clearInterval(id); } id = setInterval(tick, 10); return stop;",
      true,
    ],
  ] as const;
  const results = await Promise.all(
    cases.map(async ([body]) =>
      lintSingleRule(RULE, `const owner = () => { ${body} };`),
    ),
  );
  expect(results.map((lines) => lines.length === 0)).toEqual(
    cases.map(([, owned]) => owned),
  );
});

test("external shared-ref helpers keep the same resolved cancellation owner", async () => {
  expect(
    await lintSingleRule(
      RULE,
      `
    const ref = { current: 0 };
    export const schedule = () => { ref.current = setInterval(tick, 10); };
    export const stop = () => { clearInterval(ref.current); };
  `,
    ),
  ).toEqual([]);
});

test("a recursive helper hands each frame to its caller on the executed path", async () => {
  const cases = [
    ["onFrame(frame);", true],
    ["if (ready()) onFrame(frame);", false],
    ["const unused = () => onFrame(frame);", false],
  ] as const;
  const results = await Promise.all(
    cases.map(async ([handoff]) =>
      lintSingleRule(
        RULE,
        `const schedule = ({ onFrame, remaining }) => {
      if (remaining <= 0) return;
      const frame = requestAnimationFrame(() => schedule({ onFrame, remaining: remaining - 1 }));
      ${handoff}
    };`,
      ),
    ),
  );
  expect(results.map((lines) => lines.length === 0)).toEqual(
    cases.map(([, owned]) => owned),
  );
});

test("effect cleanup obligations start on the path that creates each timer", async () => {
  const cases = [
    [
      "if (enabled) { const id = setInterval(tick, 10); return () => clearInterval(id); }",
      true,
    ],
    [
      "if (enabled) { const id = setInterval(tick, 10); if (ready()) return () => clearInterval(id); }",
      false,
    ],
    [
      "if (enabled) return () => {}; const id = setInterval(tick, 10); return () => clearInterval(id);",
      true,
    ],
    [
      "if (enabled) { const id = setInterval(tick, 10); return () => clearInterval(id); } else return () => {};",
      true,
    ],
    [
      "if (enabled) { if (ready()) { const id = setInterval(tick, 10); return () => clearInterval(id); } }",
      true,
    ],
    [
      "const id = setInterval(tick, 10); if (enabled) return () => clearInterval(id);",
      false,
    ],
    ["try { return; } finally { const id = setInterval(tick, 10); }", false],
    [
      "try { throw failure; } finally { const id = setInterval(tick, 10); }",
      false,
    ],
    [
      "try { return; } finally { const id = setInterval(tick, 10); return () => clearInterval(id); }",
      false,
    ],
    ["if (enabled) { const id = setInterval(tick, 10); consume(id); }", true],
    [
      "if (enabled) { const id = setInterval(tick, 10); if (ready()) consume(id); }",
      false,
    ],
  ] as const;
  const results = await Promise.all(
    cases.map(async ([body]) =>
      lintSingleRule(RULE, `useEffect(() => { ${body} }, [enabled]);`),
    ),
  );
  expect(results.map((lines) => lines.length === 0)).toEqual(
    cases.map(([, owned]) => owned),
  );
});

test("ownership does not follow an overwritten timer handle", async () => {
  const sources = [
    "useEffect(() => { let id = setInterval(tick, 10); id = setInterval(tick, 20); return () => clearInterval(id); }, []);",
    "useEffect(() => { let id = setInterval(tick, 10); id = undefined; return () => clearInterval(id); }, []);",
    "useEffect(() => { let id = setInterval(tick, 10); const replace = () => { id = setInterval(tick, 20); }; return () => clearInterval(id); }, []);",
    "useEffect(() => { let frame = 0; const tick = () => { if (ready()) frame = requestAnimationFrame(tick); }; frame = requestAnimationFrame(tick); frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame); }, []);",
  ];
  const results = await Promise.all(
    sources.map(async (source) => lintSingleRule(RULE, source)),
  );
  expect(results.map((lines) => lines.length > 0)).toEqual(
    sources.map(() => true),
  );
});

test("a frame handle resets only after cancellation has executed", async () => {
  const cases = [
    ["cancelAnimationFrame(frame); frame = 0;", true],
    ["if (ready()) cancelAnimationFrame(frame); frame = 0;", false],
    ["frame = 0; cancelAnimationFrame(frame);", false],
    [
      "if (ready()) cancelAnimationFrame(frame); else cancelAnimationFrame(frame); frame = 0;",
      true,
    ],
  ] as const;
  const results = await Promise.all(
    cases.map(async ([cancel]) =>
      lintSingleRule(
        RULE,
        `const start = () => {
      let frame = 0;
      const tick = () => { frame = 0; if (visible()) frame = requestAnimationFrame(tick); };
      const cancel = () => { ${cancel} };
      return { cancel, run: () => { frame = requestAnimationFrame(tick); } };
    };`,
      ),
    ),
  );
  expect(results.map((lines) => lines.length === 0)).toEqual(
    cases.map(([, owned]) => owned),
  );
});

test("a frame callback retains each newly scheduled handle until cancellation", async () => {
  const cases = [
    ["frame = 0; if (visible()) frame = requestAnimationFrame(tick);", true],
    ["if (visible()) frame = requestAnimationFrame(tick); frame = 0;", false],
    [
      "if (visible()) frame = requestAnimationFrame(tick); cancelAnimationFrame(frame); frame = 0;",
      true,
    ],
    [
      "cancelAnimationFrame(frame); if (visible()) frame = requestAnimationFrame(tick); frame = 0;",
      false,
    ],
  ] as const;
  for (const member of [false, true]) {
    const results = await Promise.all(
      cases.map(async ([body]) =>
        lintSingleRule(
          RULE,
          `useMountEffect(() => { ${member ? "const ref = { current: 0 };" : "let frame = 0;"} const tick = () => { ${member ? body.replaceAll("frame", "ref.current") : body} }; ${member ? "ref.current" : "frame"} = requestAnimationFrame(tick); return () => cancelAnimationFrame(${member ? "ref.current" : "frame"}); });`,
        ),
      ),
    );
    expect(results.map((lines) => lines.length === 0)).toEqual(
      cases.map(([, owned]) => owned),
    );
  }
});

test("recursive frame writes cannot replace another pending frame", async () => {
  const cases = [
    [
      "if (visible()) { frame = requestAnimationFrame(tick); return; } if (moving()) { frame = requestAnimationFrame(tick); return; }",
      true,
    ],
    [
      "if (visible()) { frame = requestAnimationFrame(tick); } if (moving()) { frame = requestAnimationFrame(tick); return; }",
      false,
    ],
    [
      "try { if (visible()) { frame = requestAnimationFrame(tick); return; } } finally { if (moving()) frame = requestAnimationFrame(tick); }",
      false,
    ],
    [
      "if (visible()) for (let i = 0; i < 2; i++) frame = requestAnimationFrame(tick);",
      false,
    ],
    [
      "if (visible()) for (let i = 0; i < 2; i++) { cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); }",
      true,
    ],
    [
      "if (visible()) { frame = requestAnimationFrame(tick); frame = requestAnimationFrame(tick); }",
      false,
    ],
    [
      "if (visible()) frame = requestAnimationFrame(tick); else if (moving()) frame = requestAnimationFrame(tick);",
      true,
    ],
    [
      "if (visible()) { frame = requestAnimationFrame(tick); cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); }",
      true,
    ],
    [
      "if (visible()) { cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); frame = requestAnimationFrame(tick); }",
      false,
    ],
    [
      "if (visible()) { frame = requestAnimationFrame(tick); if (ready()) cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); }",
      false,
    ],
  ] as const;
  for (const member of [false, true]) {
    const results = await Promise.all(
      cases.map(async ([body]) =>
        lintSingleRule(
          RULE,
          `useMountEffect(() => { ${member ? "const ref = { current: 0 };" : "let frame = 0;"} const tick = () => { ${member ? body.replaceAll("frame", "ref.current") : body} }; ${member ? "ref.current" : "frame"} = requestAnimationFrame(tick); return () => cancelAnimationFrame(${member ? "ref.current" : "frame"}); });`,
        ),
      ),
    );
    expect(results.map((lines) => lines.length === 0)).toEqual(
      cases.map(([, owned]) => owned),
    );
  }
});

test("an earlier handle handoff does not own a subsequently started timer", async () => {
  expect(
    await lintSingleRule(
      RULE,
      "useEffect(() => { let id; consume(id); id = setInterval(tick, 10); return () => {}; }, []);",
    ),
  ).not.toEqual([]);
});

test("effect-started component frame loops belong to that effect cleanup", async () => {
  const cases = [
    [
      "useMountEffect(() => { frame.current = requestAnimationFrame(tick); }); const onClick = () => cancelAnimationFrame(frame.current);",
      false,
    ],
    [
      "useMountEffect(() => { frame.current = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame.current); });",
      true,
    ],
    [
      "useMountEffect(() => { frame.current = requestAnimationFrame(() => tick()); }); const onClick = () => cancelAnimationFrame(frame.current);",
      false,
    ],
  ] as const;
  const results = await Promise.all(
    cases.map(async ([start]) =>
      lintSingleRule(
        RULE,
        `const Comp = () => { const frame = { current: 0 }; const tick = () => { if (visible()) frame.current = requestAnimationFrame(tick); }; ${start} };`,
      ),
    ),
  );
  expect(results.map((lines) => lines.length === 0)).toEqual(
    cases.map(([, owned]) => owned),
  );
});
