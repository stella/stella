# Intentional network budget changes

Main records and publishes the shared network baseline. PR and merge-queue
checks compare against a published recording at or before their merge base,
using the committed baseline at that base when a recording is unavailable.
The job summary identifies the selected source. PRs must not edit
`../network-baseline.json`.

Fix unintended growth first. For an intentional increase, add one reviewed
JSON file here per change, for example `contacts-labels.json`:

```json
{
  "route": "/contacts",
  "reason": "Load labels with the contact list",
  "budget": {
    "depth": 2,
    "requests": ["GET /v1/contacts", "GET /v1/labels"],
    "requestCounts": { "GET /v1/contacts": 1, "GET /v1/labels": 1 },
    "dbQueries": { "GET /v1/contacts": 4, "GET /v1/labels": 2 },
    "responseSizes": { "GET /v1/contacts": 4096, "GET /v1/labels": 1024 }
  }
}
```

Use measured values and retain applicable existing budgets. A declaration
replaces only its named route's budget; the same depth, repeat, query and size
allowances still apply. Redirect destinations use the ` target` suffix.
Declarations added or modified since the merge base apply to that check;
inherited or deleted files grant no increase. Duplicate route declarations
fail validation.

New and removed routes are scoped from changed route sources in the base and
current route trees. New-route measurements and measurements on edited routes
appear in the job summary. Existing routes still fail on growth without a
budget declaration, including edited routes. Local `write` and `rewrite` runs
remain available for measurement; keep their shared JSON output out of PRs.

Publication follows a successful main recording asynchronously. Until the
recording is available, checks retain the previous main budget and fail closed
on uncovered unchanged routes. Main recording runs after runtime changes and
nightly; dispatch the recorder from main to publish a fresh measurement.
