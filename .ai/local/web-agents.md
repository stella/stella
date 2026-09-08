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

## Typed Query Cache Access

- Use the owning query options' `.queryKey` for `getQueryData` and `setQueryData`;
  infer data from that key instead of passing explicit type arguments. An inferred
  `const` alias preserves the tag; a standalone key factory or `QueryKey` annotation
  does not. `require-query-options-key` enforces the syntax in production web code;
  `check:query-cache-types` verifies the actual TanStack tag across imports.
- Keep named `*Options` exports and `*Keys` prefixes for family invalidation.
  Shared cache helpers may accept a TanStack `DataTag` parameter when their contract
  genuinely spans multiple query producers. Do not manufacture options or cast a
  bare key to satisfy the rule.
