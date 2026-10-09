Query performance baseline increases use the ratchet allowance shape:

```json
{
  "metric": "query-perf-shared-blocks",
  "file": "growth-document-search",
  "delta": 20,
  "reason": "Explain the additional query work."
}
```

Use one `slug.json` per metric and entry. `file` names the profile and registry entry.
Metrics are `query-perf-shared-blocks` and `query-perf-execution-time-us`;
execution time deltas use integer microseconds. Only declarations added or
changed since the comparison base apply. The positive delta must match the
baseline increase exactly; duplicate and stale declarations fail.

Run `bun scripts/query-perf-baseline.ts <base-ref>` to check changes.
