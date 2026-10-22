## Where Feature Code Lives

- `routes/<route>/-components` (and `-hooks`, etc.): code used by exactly one
  route. [check: ratchet:cross-route-private-imports]
- `features/<area>/`: a feature used by more than one route (the vertical-slice
  home). [review]
- `components/`: UI shared across features, with no feature-specific logic. The
  `slice-owned-web-components` ratchet counts `components/` files whose
  importers all sit in one feature or one route; it may only shrink.
  [check: ratchet:slice-owned-web-components]

## End-to-End Tests

- Browser navigation must name `waitUntil: "commit"` or
  `waitUntil: "domcontentloaded"`, then synchronize on the specific UI that makes the
  route ready. Never use the default `load` event as application readiness;
  `navigation-policy.unit.spec.ts` enforces this for every E2E spec.
  [test: apps/web/e2e/specs/navigation-policy.unit.spec.ts]
- A successful HTTP response is not necessarily completion of the user action that
  issued it. Wait for the product's visible completion state before asserting settled
  UI or navigating away. [review]

## Error Handling

- Web code returns `Result`; `try`/`catch` belongs only to the boundary modules
  listed in `scripts/result-boundary-globs.ts`.
  [lint: result-boundary/no-try-catch-outside-boundary]

## Typed Query Cache Access

- Use the owning query options' `.queryKey` for `getQueryData` and `setQueryData`;
  infer data from that key instead of passing explicit type arguments. An inferred
  `const` alias preserves the tag; a standalone key factory or `QueryKey` annotation
  does not. `require-query-options-key` enforces the syntax in production web code;
  `check:query-cache-types` verifies the actual TanStack tag across imports.
  [lint: require-query-options-key/require-query-options-key]
- Keep named `*Options` exports and `*Keys` prefixes for family invalidation.
  Shared cache helpers may accept a TanStack `DataTag` parameter when their contract
  genuinely spans multiple query producers. Do not manufacture options or cast a
  bare key to satisfy the rule. [review]

## Form Validation

- Construct TanStack forms with `useForm(schemaFormOptions(...))` from
  `@/lib/schema`. Supply `schema`, `defaultValues`, `submitValues`, and
  `onSubmit`. The helper validates on the first submit, then revalidates on change.
  `require-schema-form-options` enforces this for every production web form,
  without a grandfathered baseline. Pass the helper call directly to `useForm`
  so later option spreads cannot replace its validation or submit contract.
  [lint: require-schema-form-options/require-schema-form-options]
- Choose `submitValues: "schema-output"` to submit Valibot's parsed output or
  `"raw"` to deliberately preserve validated input. There is no default. Define
  trimming, casing, and other transformations in the schema; never normalize
  every string indiscriminately (passwords and free text may need preservation).
  [lint: require-schema-form-options/require-schema-form-options]
- Submit handlers receive the chosen value type. Do not repeat `safeParse` with a
  silent early return or parse the same schema in the handler. Invalid values
  belong in field errors. Domain failures still belong in the submit handler.
  [review]
