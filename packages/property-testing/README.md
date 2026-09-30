# @stll/property-testing

Shared fast-check wiring for the repo's property tests. No arbitraries
live here — write those next to the code under test. This package owns
the three things every property must agree on: how long it runs, how long
it may take, and which inputs it draws.

## Writing a property

```ts
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

fc.assert(
  fc.property(arbitrary, (value) => {
    expect(normalize(normalize(value))).toBe(normalize(value));
  }),
  propertyConfig({ numRuns: 300 }),
);
```

Every `fc.assert` or `fc.check` call must pass parameters through
`propertyConfig` (directly or through a configured helper), or use
`assertProperty`. The guard checks each call, including files that already
import the configuration helper. The workspace also needs a `test:property` script preloading
`@stll/property-testing/preload`; `convention.test.ts` holds the set of
workspaces with property files and the set with that script to exact
agreement, in both directions.

## Seeding: fixed in CI, exploring nightly

`propertyConfig()` defaults an omitted `seed` key to `propertySeed()`: a fixed
seed in PR CI and `undefined` during the nightly sweep, so fast-check draws
its own. Callers do not need to pass `propertySeed()` themselves. An explicitly
supplied seed is preserved.

The two runs answer different questions. **PR CI is a regression gate.**
It has to fail the same way for everyone who runs it; a counterexample
that appears for one engineer and not the next is a flake, and a flaky
gate gets muted. **The nightly sweep is the search.** It already runs
every property ten times longer, and reusing one seed there would re-walk
the same inputs every night — the extra budget would buy nothing.

Nightly is detected from `PROPERTY_TEST_NUM_RUNS_FACTOR`, which
`.github/workflows/nightly-property-test.yml` already exports to widen
the run budget. One signal means the sweep cannot end up scaled but not
exploring, or the reverse.

### Replaying a nightly failure

The nightly run log prints the seed fast-check drew. Export it and the
run reproduces, without editing the test:

```sh
PROPERTY_TEST_SEED=1234 bun run test:property
```

`PROPERTY_TEST_SEED` controls the default seed in every environment, sweep or
not. A non-integer value throws rather than being silently ignored. A seed
explicitly supplied by the caller takes precedence over this default.

## Environment variables

| Variable                        | Set by                       | Effect                                                                                                    |
| ------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PROPERTY_TEST_NUM_RUNS_FACTOR` | nightly workflow             | Scales every property's `numRuns` and `propertyTestTimeout`; also switches `propertySeed()` to exploring. |
| `PROPERTY_TEST_SEED`            | a person replaying a failure | Pins `propertySeed()` to that seed.                                                                       |
| `PROPERTY_TEST_TIMEOUT_BASE_MS` | owning test runner           | Baseline `propertyTestDefaultTimeout()` scales from.                                                      |
| `CI`                            | CI                           | Turns on fast-check verbose reporting, so a failing run logs every shrunk value.                          |
