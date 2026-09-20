# Workspace interaction replay

This suite drives a synthetic matter and document through deterministic,
state-aware browser actions. Its replay JSON records only structural state:
never cookies, headers, request or response bodies, document text, or
credentials.

The scheduled runner discovers selectable control families from stable owner
attributes. New workspace tabs, inspector facets, and segmented view-toolbar
options join the search without a corresponding action-schema change. Exact
artifact replay is intentionally strict: it reports when those capabilities or
their selected state have changed.

CI runs the explorer only in the scheduled `Nightly Full Test` workflow. The
nightly job uses one Chromium worker, a fresh run-id seed, 200 actions, and a
10-minute Playwright ceiling within a 30-minute job budget. It uploads the
sanitized replay, trace, screenshots/video, and server logs only on failure.

Start the normal local stack, then run the fixed default sequence:

```sh
bun --filter @stll/web test:e2e:soak
```

Choose a seed and step budget:

```sh
E2E_SOAK_SEED=20260919 E2E_SOAK_STEPS=250 \
  bun --filter @stll/web test:e2e:soak
```

Replay an attached artifact exactly:

```sh
E2E_SOAK_REPLAY=/absolute/path/to/workspace-replay.json \
  bun --filter @stll/web test:e2e:soak
```

Replay fails at the first action that is no longer applicable. It never
silently replaces a recorded action with a newly sampled one.
