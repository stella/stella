# Searchable select sampling

The initial `apps/web/src` sample reported these two long time-zone lists.
Both were replaced by the shared searchable picker in this change:

| Location                                                                               | Disposition                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------ |
| `apps/web/src/routes/_protected.settings/account.profile.tsx:521`                      | Replaced with the shared time-zone picker. |
| `apps/web/src/routes/_protected.admin/-components/organization/time-zone-card.tsx:110` | Replaced with the shared time-zone picker. |

The sample also printed `break-words` at `apps/web/src/lib/time-zone-picker.tsx:74,83`
and `no-raw-locale-format` at `apps/web/src/lib/time-zone-picker.logic.ts:20`.
These were corrected with `wrap-break-word` and canonical temporal
offset formatting.

The rule resolves direct literal arrays exported from relative imports and
`@/` imports rooted at `apps/web/src`, follows one local identifier alias,
and treats a local function that references such a list as a long-list source
when its return value is mapped into a Select. It does not follow package imports, re-export
chains, dynamic arrays, or values built only at runtime. Lists are flagged
when the source has more than 30 entries; the rule also counts explicit JSX
items and covers native `select`/`option` markup.

Validation:

- Picker logic, DOM keyboard selection, and organization save semantics: 7 tests passed.
- Searchable-select rule and fixture-harness tests: 31 tests passed (9 rule tests, 22 harness tests).
- API settings projection: 10 focused tests passed using a fixture database URL; no database queries were needed.
- Removing the browser pin failed the pin-order test; removing offset matching failed the +01:00 search test. Both mutations were restored.
- All shipped locale catalogs passed i18n sync and quality checks; existing translated strings are reused.

Fixture conventions: the registry previously required disable directives for
positive cases. It now also accepts explicitly wrapped suppression-free
expect-error fixtures, with exact diagnostic counts verified by the same harness.
Existing directive fixtures can migrate independently.
