# Testing Conventions

Apply when writing or reviewing tests.

## What to test

**Test when code has:** parsing/transformation logic, security
boundaries, business rules with arithmetic, state machines,
non-obvious edge cases, or CRUD paths with auth, tenancy,
validation, serialization, uploads/downloads, or other side
effects. **Skip:** shallow CRUD handlers with no meaningful
branching, library wrappers, layout components, constants.

## Prefer invariants over examples

When the input space is large (parsers, document transforms,
normalization, sorting/filtering, security boundaries,
Unicode-heavy logic), start by asking what must always be true,
then encode that as a property test, fuzzy test, or adversarial
regression test. Reach for ordinary example tests when they
communicate a business rule more clearly than a property.

**Good property/fuzz targets in Stella:** DOCX/OOXML roundtrips,
template/block-directive parsing, filename and header sanitization,
search/filter/sort helpers, tenant-scope enforcement, and error
normalization.

## Structure

Colocate `foo.test.ts` next to `foo.ts`. For frontend, default
to extracting logic into `foo.logic.ts` and test that in Bun.
Use Playwright for browser-only behavior: auth redirects, route
guards, uploads/downloads, keyboard/focus, drag/drop, and
viewer/editor flows. Structural invariant tests (auth
enforcement, branded types) live in
`apps/api/src/tests/security/`.

## Rules

- Use `bun:test` for unit, invariant, and integration tests;
  use Playwright for browser behavior. Do not add another test
  runner without a clear gap Bun and Playwright cannot cover.
- Describe by behaviour, not by function name
- Avoid hidden shared mutable state. Prefer per-test setup; use
  `beforeEach` only for deterministic reset, and use expensive
  shared fixtures only when explicit and isolated
- Prefer plain fakes over mocking libraries for simple cases;
  use mocks when simulating failure modes, testing varied
  edge-case inputs, or isolating external services
- Test tenant isolation and ownership-source rules at the
  highest meaningful layer, not only as pure helper tests
- Every bug fix gets a regression test
- Avoid "tests for tests' sake": don't add shallow examples
  just to increase coverage if a stronger invariant test would
  cover the same surface with more signal
