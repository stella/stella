# Testing Conventions

Apply when writing or reviewing tests.

## What to test

**Test when code has:** parsing/transformation logic, security
boundaries, business rules with arithmetic, state machines,
non-obvious edge cases. **Skip:** simple CRUD handlers,
library wrappers, layout components, constants.

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

Colocate `foo.test.ts` next to `foo.ts`. For frontend, extract
logic into `foo.logic.ts` and test that (no React/DOM needed).
Structural invariant tests (auth enforcement, branded types)
live in `apps/api/src/tests/security/`.

## Rules

- `bun:test` only
- Describe by behaviour, not by function name
- No `beforeEach` / shared mutable state
- Prefer plain fakes over mocking libraries for simple cases;
  use mocks when simulating failure modes, testing varied
  edge-case inputs, or isolating external services
- Every bug fix gets a regression test
- Avoid "tests for tests' sake": don't add shallow examples
  just to increase coverage if a stronger invariant test would
  cover the same surface with more signal
