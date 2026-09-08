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

## Form Validation

- Construct TanStack forms with `useForm(schemaFormOptions({ schema, defaultValues,
  submitValues, onSubmit }))` from `@/lib/form-options`. The helper owns dynamic
  validation timing: validate on the first submit, then revalidate on change.
- Choose `submitValues: "schema-output"` to submit Valibot's parsed output or
  `"raw"` to deliberately preserve validated input. There is no default. Define
  trimming, casing, and other transformations in the schema; never normalize
  every string indiscriminately (passwords and free text may need preservation).
- Submit handlers receive the chosen value type. Do not repeat `safeParse` with a
  silent early return or parse the same schema in the handler. Invalid values
  belong in field errors. Domain failures still belong in the submit handler.
- `require-schema-form-options` enforces this for every production web form,
  without a grandfathered baseline. Pass the helper call directly to `useForm`
  so later option spreads cannot replace its validation or submit contract.
