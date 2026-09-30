# @stll/property-testing

Shared fast-check wiring for property budgets, seeds, and replayable failures.
Keep arbitraries beside the code under test.

## Writing a property

```ts
import { expect, test } from "bun:test";
import fc from "fast-check";
import { assertProperty } from "@stll/property-testing";

test("normalization is idempotent", () => {
  assertProperty(
    "normalization is idempotent",
    fc.property(arbitrary, (value) => {
      expect(normalize(normalize(value))).toBe(normalize(value));
    }),
    { numRuns: 300 },
  );
});
```

Use an explicit stable id matching the literal test title so `bun test -t`
selects the property. Async properties return a promise: await it or return it
from the test. Custom reporters are unsupported because this API owns failure
reporting. Older `fc.assert(property, propertyConfig({ seed: propertySeed() }))`
call sites remain supported; migrate them to `assertProperty` to replay pins.

Every workspace with properties needs a `test:property` script preloading
`@stll/property-testing/preload`. Property runners select both `fc.assert` and
`assertProperty`; the convention guard checks workspace/script agreement.

Every `fc.assert` or `fc.check` call must pass parameters through
`propertyConfig`, directly or through a configured helper. The guard checks
each call, including files that already import the configuration helper.

`propertyConfig()` defaults an omitted `seed` key to `propertySeed()`: a fixed
seed in PR CI and `undefined` during the nightly sweep, so fast-check draws
its own. Callers do not need to pass `propertySeed()` themselves. An explicitly
supplied seed is preserved.

`PROPERTY_TEST_SEED` controls the default seed in every environment, sweep or
not. A non-integer value throws rather than being silently ignored. A seed
explicitly supplied by the caller takes precedence over this default.

## Seeds and failures

`assertProperty` first replays every entry under `<repo-relative file>::<id>`
in `property-seeds.json`, then runs the ordinary `propertyConfig` pass with
`propertySeed()`. Replays clear examples so recorded paths remain stable and
ignore nightly time limits. PR and merge-queue runs use the fixed seed
`20_260_901` plus pinned seeds. No per-commit random seed is used in PR CI.
The private nightly tier uses factor 10 and an explicit exploratory seed (or
fast-check's random seed when none is supplied).

Failures throw fast-check's report followed by a shell-quoted `Replay:` command
(run it from the repository root) and a `Pin:` JSON hint (fill its date after the fix merges). For example:

```sh
PROPERTY_TEST_SEED=1234 PROPERTY_TEST_PATH='0:1' bun test packages/example/src/normalize.property.test.ts -t 'normalization is idempotent'
```

`PROPERTY_TEST_PATH` applies only when the selected seed equals the explicitly
set `PROPERTY_TEST_SEED`; pinned entries always use their own path. A failing
seed is a real bug: fix it, then pin it after the fix merges. Extend the generator
or oracle to cover the input class. Never rerun until green. Public notes must
be neutral; sensitive counterexamples belong in private reports.

```json
{
  "packages/example/src/normalize.property.test.ts::normalization is idempotent": [
    {
      "seed": 1234,
      "path": "0:1",
      "note": "Regression coverage",
      "date": "2026-09-30"
    }
  ]
}
```

`$`-prefixed keys are comments. The seed meta-test requires existing tests using
the named explicit id, integer seeds, paths matching `^\d+(:\d+)*$`, and a
nonempty note and ISO date.

Under CI each failed assertion emits one `STELLA_PROPERTY_FAILURE {json}` line:
`file`, `id`, `seed`, `path`, `factor`, `fingerprint`, and `replay`, plus
`counterexample` only when `PROPERTY_TEST_REDACT` is unset. Redaction applies to
the machine marker; fast-check's thrown report still contains failure details.
`failureFingerprint({ id, error })` hashes the id and normalized first error
line (quoted strings, UUIDs, hex ids, and numbers masked), returning 16 hex
characters. It is pure and independent of file, seed, and later stack lines.

## Environment variables

| Variable                        | Effect                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROPERTY_TEST_NUM_RUNS_FACTOR` | Scales `numRuns` and Bun timeouts; a factor above 1 selects exploratory seeds.                                                              |
| `PROPERTY_TEST_SEED`            | Pins the generated pass in every environment, unless the property supplies its own seed. Invalid integers throw.                            |
| `PROPERTY_TEST_PATH`            | Replays the counterexample for the matching explicitly set seed.                                                                            |
| `PROPERTY_TEST_TIME_LIMIT_MS`   | Positive integer; nightly generation uses `interruptAfterTimeLimit` with `markInterruptAsFailure: false`. Does not truncate pinned replays. |
| `PROPERTY_TEST_REDACT`          | Any set value omits counterexamples from CI markers.                                                                                        |
| `PROPERTY_TEST_TIMEOUT_BASE_MS` | Owning runner's baseline for the factor-scaled Bun timeout.                                                                                 |
| `CI`                            | Enables verbose fast-check reports and failure markers.                                                                                     |

Time boxing interrupts between evaluations; it cannot preempt a synchronous
predicate that never returns. Keep hostile-input parsers bounded independently.
