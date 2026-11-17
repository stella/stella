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

- A successful HTTP response is not necessarily completion of the user action that
  issued it. Wait for the product's visible completion state before asserting settled
  UI or navigating away. [review]

## Memoization

- The React Compiler memoizes every web function it compiles, so web code
  leaves memoization to it instead of the gradual cleanup above, and
  `no-manual-memo` rejects `useMemo`, `useCallback` and memo directives in
  compiled files. Keep a manual memo only where an effect dependency must stay
  stable, a library needs item identity, or it keeps a hook compiled, and name
  which in the suppression reason. Files with a compiler bailout keep their
  memoization until it is fixed.

## Typed Query Cache Access

- Keep named `*Options` exports and `*Keys` prefixes for family invalidation.
  Shared cache helpers may accept a TanStack `DataTag` parameter when their contract
  genuinely spans multiple query producers. Do not manufacture options or cast a
  bare key to satisfy the rule. [review]

## Form Validation

- Submit handlers receive the chosen value type. Do not repeat `safeParse` with a
  silent early return or parse the same schema in the handler. Invalid values
  belong in field errors. Domain failures still belong in the submit handler.
  [review]
