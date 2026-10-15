import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { SLEEP_HELPERS } from "../no-hand-rolled-concurrency.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const rule = "no-real-timers-in-tests";
const options = { sourcePath: "x.test.ts" };

test("reports native timers, global receivers, aliases, and destructured timers", async () => {
  const source = [
    "setTimeout(() => {}, 1);",
    "setInterval(() => {}, 1);",
    "Bun.sleep(1);",
    "globalThis.setTimeout(() => {}, 1);",
    "globalThis.setInterval(() => {}, 1);",
    "globalThis.Bun.sleep(1);",
    "const timeout = setTimeout; timeout(() => {}, 1);",
    "const runtime = Bun; runtime.sleep(1);",
    "const { setInterval: interval } = globalThis; interval(() => {}, 1);",
    "const { sleep: pause } = Bun; pause(1);",
    "const root = globalThis; root['setTimeout'](() => {}, 1);",
    "window.setTimeout(() => {}, 1); self.setInterval(() => {}, 1);",
  ].join("\n");
  expect(await lintSingleRule(rule, source, options)).toEqual([
    ...Array.from({ length: 12 }, (_, index) => index + 1),
    12,
  ]);
});

test("recognizes Node timer imports while allowing unrelated imported names", async () => {
  expect(
    await lintSingleRule(
      rule,
      [
        "import { setTimeout as pause } from 'node:timers/promises'; pause(1);",
        "import * as timers from 'node:timers'; timers.setInterval(() => {}, 1);",
        "import { setTimeout as custom } from './scheduler'; custom();",
        "import * as kit from '@stll/test-kit'; kit.sleep(1);",
      ].join("\n"),
      options,
    ),
  ).toEqual([1, 2]);
});

test("tracks mutable imported aliases and invoked call, apply, and bind wrappers", async () => {
  const source = [
    "import { sleep } from '@stll/concurrency/sleep';",
    "let pause; pause = sleep; pause(1);",
    "sleep.call(null, 1);",
    "sleep.apply(null, [1]);",
    "const boundSleep = sleep.bind(null, 1);",
    "boundSleep();",
    "setTimeout.call(null, () => {}, 1);",
    "Bun.sleep.apply(Bun, [1]);",
    "const boundTimer = globalThis.setInterval.bind(null, () => {}, 1);",
    "boundTimer();",
    "setTimeout.bind(null, () => {}, 1)();",
    "const timerAlias = setTimeout; const rebound = timerAlias.bind(null); rebound(() => {}, 1);",
    "const custom = { sleep() {} }; custom.sleep.call(null); custom.sleep.bind(null)();",
    "import { waitFor } from '@stll/test-kit'; waitFor.call(null, () => true);",
    "import * as timers from 'node:timers'; let timerNamespace; timerNamespace = timers; timerNamespace.setTimeout(() => {}, 1);",
    "import * as helpers from './delays'; let helperAlias; helperAlias = helpers; helperAlias.sleep(1);",
  ].join("\n");
  expect(await lintSingleRule(rule, source, options)).toEqual([
    2, 3, 4, 6, 7, 8, 10, 11, 12, 15, 16,
  ]);
});

test("reports each canonical imported sleep helper including renamed and namespace bindings", async () => {
  const source = [...SLEEP_HELPERS].flatMap((helper, index) => [
    `import { ${helper} as helper${index} } from './delays';`,
    `helper${index}(1);`,
  ]);
  source.push(
    "import { sleep as pause } from '@stll/concurrency';",
    "pause(1);",
    "import * as concurrency from '@stll/concurrency/sleep';",
    "const alias = concurrency.sleep; alias(1);",
    "const { sleep: destructured } = concurrency; destructured(1);",
  );
  expect(await lintSingleRule(rule, source.join("\n"), options)).toEqual([
    ...[...SLEEP_HELPERS].map((_, index) => index * 2 + 2),
    source.length - 3,
    source.length - 1,
    source.length,
  ]);
});

test("reports unbound sleep helpers without confusing local functions or shadowed native names", async () => {
  expect(
    await lintSingleRule(
      rule,
      [...SLEEP_HELPERS].map((name) => `${name}(1);`).join("\n"),
      options,
    ),
  ).toEqual([...SLEEP_HELPERS].map((_, index) => index + 1));
  expect(
    await lintSingleRule(
      rule,
      [
        "function check(setTimeout, setInterval, Bun, globalThis, sleep, delay) {",
        "setTimeout(); setInterval(); Bun.sleep(); globalThis.setTimeout(); sleep(); delay();",
        "}",
        "const custom = { sleep() {}, setTimeout() {} }; custom.sleep(); custom.setTimeout();",
        "const sleep = () => {}; const alias = sleep; alias();",
        "new Date(0);",
      ].join("\n"),
      options,
    ),
  ).toEqual([]);
});

test("allows test-kit helpers, production files, and the real-clock owner", async () => {
  expect(
    await lintSingleRule(
      rule,
      "import { sleep, waitFor, deferred } from '@stll/test-kit'; sleep(1); waitFor(() => true); deferred();",
      options,
    ),
  ).toEqual([]);
  for (const sourcePath of ["x.ts", "packages/test-kit/src/clock.test.ts"]) {
    expect(
      await lintSingleRule(rule, "setTimeout(() => {}, 1);", { sourcePath }),
    ).toEqual([]);
  }
  expect(
    await lintSingleRule(rule, "setTimeout(() => {}, 1);", {
      sourcePath: "x.property.spec.ts",
    }),
  ).toEqual([1]);
});

test("requires a reason for escapes and counts reasoned escapes in the baseline", async () => {
  const source = [
    "// kit-allow: verifies a real host timer boundary",
    "setTimeout(() => {}, 1);",
    "setInterval(() => {}, 1); // kit-allow: verifies interval cleanup",
    "// kit-allow:",
    "Bun.sleep(1);",
  ].join("\n");
  expect(await lintSingleRule(rule, source, options)).toEqual([5]);
  expect(
    await lintSingleRule(rule, source, {
      ...options,
      settings: { testDeterminismBaseline: { "x.test.ts": 3 } },
    }),
  ).toEqual([]);
  expect(
    await lintSingleRule(
      rule,
      "// kit-allow: host boundary\nBun.sleep(1);\nBun.sleep(2);",
      {
        ...options,
        settings: { testDeterminismBaseline: { "x.test.ts": 1 } },
      },
    ),
  ).toEqual([3]);
});

test("accepts the exact budget, reports excess hits, and rejects a stale budget", async () => {
  const settings = { testDeterminismBaseline: { "x.test.ts": 1 } };
  expect(
    await lintSingleRule(rule, "Bun.sleep(1);", { ...options, settings }),
  ).toEqual([]);
  expect(
    await lintSingleRule(rule, "Bun.sleep(1);\nBun.sleep(2);", {
      ...options,
      settings,
    }),
  ).toEqual([2]);
  expect(
    await lintSingleRule(rule, "const value = 1;", { ...options, settings }),
  ).toEqual([1]);
});

test("the registered fixture reaches the rule and a wrong clean fixture fails", async () => {
  const fixture = readFileSync(
    new URL(
      "../__fixtures__/no-real-timers-in-tests.fixture.test.ts",
      import.meta.url,
    ),
    "utf-8",
  );
  expect(await lintSingleRule(rule, fixture, options)).toEqual([]);
  const wrongFixture = fixture.replace(
    "deferred();",
    "globalThis.setInterval(() => {}, 1);",
  );
  expect(wrongFixture).not.toBe(fixture);
  expect(await lintSingleRule(rule, wrongFixture, options)).toEqual([7]);
  const unsuppressed = fixture.replace(
    "oxlint-disable-next-line",
    "fixture-violation",
  );
  expect(await lintSingleRule(rule, unsuppressed, options)).toEqual([4]);
});
