## End-to-End Tests

- Browser navigation must name `waitUntil: "commit"` or
  `waitUntil: "domcontentloaded"`, then synchronize on the specific UI that makes the
  route ready. Never use the default `load` event as application readiness;
  `navigation-policy.unit.spec.ts` enforces this for every E2E spec.
- A successful HTTP response is not necessarily completion of the user action that
  issued it. Wait for the product's visible completion state before asserting settled
  UI or navigating away.

## Error Handling

- Web code returns `Result`; `try`/`catch` belongs only to the boundary modules
  listed in `scripts/result-boundary-globs.ts`.
