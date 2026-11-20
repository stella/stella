# @stll/deadlines

Explainable Czech and Slovak deadline calculations, built on `Temporal`
from `@stll/time`. This package implements the public calculation entry point
for [issue #5323](https://github.com/stella/stella/issues/5323), with explicitly
bounded holiday-calendar coverage.

## Public calculation

```ts
import { computeDeadline, DEADLINE_UNIT } from "@stll/deadlines";
import { Temporal } from "@stll/time";

const result = computeDeadline({
  jurisdiction: "SK",
  trigger: Temporal.PlainDate.from("2026-04-02"),
  period: { amount: 1, unit: DEADLINE_UNIT.DAY },
});

if (result.isOk()) {
  result.value.nominalEnd.toString(); // "2026-04-03" (Good Friday)
  result.value.end.toString(); // "2026-04-07"
  result.value.shifts.map(({ date, reason }) => ({
    date: date.toString(),
    reason,
  })); // 3 April holiday, 4–5 April weekend, 6 April holiday
  result.value.rule; // jurisdiction and the applied statutory provisions
} else {
  result.error.reason;
}
```

`computeDeadline` returns a `Result` containing `end`, `nominalEnd`, `shifts`
and `rule`. Each shift records the **non-working date skipped**, starting at
`nominalEnd` and ending before `end`; the final working date is not a shift.
If a public holiday is also a weekend, the explanation records the holiday.
Unshifted deadlines have identical end dates and an empty shift list.

The default CZ/SK rules exclude the trigger day, count calendar periods,
constrain absent month days, and move only the end forward. The calculation
reads no clock, environment, database or network state and does not mutate the
input date.

## Rules and legal sources

The owning `src/rules.ts` registry contains data-only `DeadlineRuleSet` values.
`createDeadlineCalculator({ rules, calendar })` binds any typed registry and
verified calendar to the same engine. Its jurisdiction input and result are
inferred from the registry keys; neither the engine nor the calendar interface
contains a CZ/SK discriminator. `computeDeadline` binds the default CZ/SK registry
and the maintained holiday adapter at call time.

| Field           | Supported choices and effect                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triggerDay`    | `exclude` or `include`. An inclusive calendar period ends one calendar day before its exclusive end; for months/years, this happens after the month-end policy. For working-day periods, the trigger counts only if it is a working day. |
| `dayCounting`   | `calendar` or `working` for **day periods**. Weeks, months and years retain calendar arithmetic and corresponding-day semantics.                                                                                                         |
| `monthEnd`      | `constrain` uses the last available day; `reject` returns `missing_target_day`.                                                                                                                                                          |
| `endAdjustment` | `next-working-day`, `previous-working-day` or `none`. `none` can deliberately return a non-working end.                                                                                                                                  |
| `courtHolidays` | `ignore` or `observe`. Observed closures affect working-day counting and final adjustment.                                                                                                                                               |
| `weekendDays`   | ISO weekday numbers 1–7; not restricted to Saturday/Sunday.                                                                                                                                                                              |
| `limits`        | `maxCountingDays` bounds dates inspected when counting working days; `maxShiftDays` bounds final adjustment. These are technical limits, not statutory period lengths.                                                                   |
| `source`        | Nonempty description of the verified legal provisions.                                                                                                                                                                                   |

Registry entries are validated before calculation; invalid modes, malformed
fields and invalid execution limits return `invalid_rule`. Public/calendar errors
remain typed `Result` failures. Backward adjustment can produce `end < nominalEnd`;
the forward-only invariant applies to the default CZ/SK policies, not every
possible configured policy.

| Jurisdiction | Procedure sources                                                                                                                                           | Holiday source                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| CZ           | [§ 57, Act 99/1963](https://www.e-sbirka.cz/sb/1963/99); [§ 40, Act 500/2004](https://www.e-sbirka.cz/sb/2004/500)                                          | [Act 245/2000, §§ 1–3](https://ppropo.mpsv.cz/zakon_245_2000)                                        |
| SK           | [§ 121, Act 160/2015](https://www.slov-lex.sk/pravne-predpisy/SK/ZZ/2015/160/); [§ 27, Act 71/1967](https://www.slov-lex.sk/pravne-predpisy/SK/ZZ/1967/71/) | [Act 241/1993, §§ 1–4b](https://www.slov-lex.sk/ezbierky-fe/pravne-predpisy/SK/ZZ/1993/241/20251101) |

### Adding a jurisdiction

1. Verify the procedure's legal sources and express its semantics as a
   `DeadlineRuleSet`. Check inclusion and month-end interactions against worked
   legal examples; a policy fixture is not evidence of another country's law.
2. Supply a `HolidayCalendar` backed by a maintained, verified source for the new
   jurisdiction. Its `jurisdiction` input is a string; unsupported dates must
   return errors. Do not add local holiday overrides. Declare court support as
   `unsupported`, or as `available` with a verified `getHoliday` lookup.
3. Pass the registry and calendar to `createDeadlineCalculator`. For built-in
   support, add the rule to `DEADLINE_RULES` and verified provider coverage to
   `HOLIDAY_COVERAGE`; add provider routing metadata when needed. None of these
   steps changes `deadline-calculator.ts`.
4. Add worked examples and properties for the selected policies, calendar
   changes, coverage boundaries and source attribution. Run the package checks
   below before widening support.

The synthetic `TEST_A`/`TEST_B` registries in `deadline-calculator.test.ts` and
`deadline-calculator.property.test.ts` are executable examples of configuring a
calculator without registering a real country. They exercise inclusion,
working-day periods, Friday/Saturday weekends, both shift directions, no shift,
missing month days and observed court closures. No further real jurisdiction
is shipped by these fixtures.

## Holiday calendar and coverage

Only `src/holiday-calendar.ts` imports the pinned `date-holidays` provider.
It requests public holidays only, with an explicit year, UTC timezone and
English holiday names. Observances do not move a deadline. The provider is
initialized lazily in a caller-owned calendar; its memoization is bounded by
the supported jurisdiction-years. There are no local holiday-data overrides.

| Jurisdiction | Verified inclusive calendar years |
| ------------ | --------------------------------- |
| CZ           | 2016–2026                         |
| SK           | 2019–2026                         |

Both the trigger and all dates consulted during adjustment must be covered.
A shift into 2027 returns `unsupported_date`, even when the trigger and nominal
end are in 2026. Coverage is an explicit verification boundary, not a claim
that later laws or holiday rules stop existing.

Known limitations in the pinned provider prevent broader coverage:

- CZ Good Friday is treated as public even before its introduction. The
  [2015 amendment](https://www.psp.cz/sqw/sbirka.sqw?cz=359&r=2015) first affects
  Easter 2016.
- SK lacks the exceptional 30 October 2018 day off (Act 241/1993, § 4a).
- SK treats 8 May and 15 September as working days indefinitely from 2026.
  The law's § 4b applies only to 2026; the [National Bank's calendar](https://nbs.sk/o-narodnej-banke/sviatky-v-sr/)
  confirms their return as days off in 2027.

Upstream data corrections and verification are required before widening these
bounds. No upstream issue or patch is published by this change. Full historical
coverage and the corresponding worked examples of #5323 remain unfinished.

The public `HolidayCalendar` contract can replace the provider through the
optional `calendar` input. Implementations return `Result<PublicHoliday | null,
DeadlineError>` from `getPublicHoliday({ jurisdiction, date })`: `null` means a
verified non-holiday; unsupported dates and provider failures must return an
error. Custom providers own their coverage and verification. The calculation
propagates their errors and never returns a partial success.

`courtHolidays` is a capability discriminator: `{ type: "unsupported" }` or
`{ type: "available", getHoliday }`. The built-in adapter declares court
calendars unsupported. Selecting `observe` with an unsupported calendar returns
`unsupported_calendar_capability`; it never silently ignores requested closures.
Explanations prioritize public holidays, then observed court holidays, then
weekends when categories overlap.

`getNonWorkingReason({ jurisdiction, date, calendar, rule })` combines the
provider's data with the explicit rule. Default adjustment is bounded at 31
skipped days; a calendar that never yields a working day returns
`adjustment_limit`. Working-day scans have a separate `counting_limit`.

## Errors

Nominal input failures return `NominalDeadlineError` as below. The public
calculation additionally returns `DeadlineError` with one of:
`unsupported_jurisdiction`, `unsupported_date`, `calendar_failure`,
`adjustment_limit`, `counting_limit`, `invalid_rule`, or
`unsupported_calendar_capability`. Month-end rejection returns
`NominalDeadlineError` with `missing_target_day`. Callers inspect the `Result`;
expected errors are not thrown.

## Nominal end

```ts
import { computeNominalEnd, DEADLINE_UNIT } from "@stll/deadlines";
import { Temporal } from "@stll/time";

const result = computeNominalEnd({
  trigger: Temporal.PlainDate.from("2026-01-31"),
  period: { amount: 1, unit: DEADLINE_UNIT.MONTH },
});

if (result.isOk()) {
  result.value.toString(); // "2026-02-28"
} else {
  result.error.reason; // invalid_period_amount, unsupported_calendar, date_out_of_range
}
```

The trigger is an ISO 8601 `Temporal.PlainDate`, with no time or timezone.
Amounts must be positive safe integers. Supported units are days, weeks,
months, and years. By default, a one-day period ends on the day after the trigger;
`triggerDay: "include"` changes inclusion and `monthEnd: "reject"` rejects absent
month days. The same arithmetic implementation serves the configurable engine.
Weeks preserve the weekday; months and years preserve the day number where
possible and otherwise use the last day of the target month. The entire
period is added in one operation, so 31 January plus two months is 31 March.

Failures return a typed `NominalDeadlineError` through `better-result`.
The trigger is never mutated and the function reads no clock, environment,
database, or network state.

## Scope

`computeNominalEnd` returns a **nominal calendar date** and leaves weekends and
holidays unchanged. Use `computeDeadline` for the explained working-day result
within the verified coverage above. The package has no product UI, MCP tool or
generated CLI command. Hour-based periods, special criminal-procedure rules and
filing-delivery timeliness are outside this implementation.

## Development

The working-day property checks every period unit against generated dates and
amounts, with explicit month-end examples for both jurisdictions, including
leap days. It verifies `end >= nominalEnd`, a working final date, and a complete
sequence of non-working skipped dates with reasons. Generated successful cases
leave room within calendar coverage for the full adjustment; coverage failures
are exercised separately.

The Easter property queries the real calendar adapter for March–April holidays,
derives the same Sunday from Good Friday and Easter Monday, and verifies its
weekday and inclusive 22 March–25 April bounds. It includes every supported
jurisdiction-year as an explicit example as well as generated cases. The
independent computus in the exhaustive calendar tests additionally checks the
exact holiday dates.

Run from the repository root:

```sh
bun --filter @stll/deadlines test
bun --filter @stll/deadlines test:property
bun --filter @stll/deadlines typecheck
bun --filter @stll/deadlines lint
```
