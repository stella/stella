---
name: conventions-testing
description: 'Apply when writing or reviewing tests.'
---

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
- Do not `mock.module` a workspace module (`@/...`, `@stll/...`, a
  relative path), and always name the target with a string literal. The
  fabricated module never drifts with the real one, so the test keeps passing
  after the contract it depends on changes, and Bun's mock registry is
  process-wide. Inject the collaborator instead (handler context, an options
  parameter) and pass a plain fake; if the module wraps an external boundary,
  mock the npm package it calls or expose a test seam.
  `no-internal-module-mock` enforces this; existing pairs are grandfathered
  in `scripts/internal-module-mock-ledger.json`, which only shrinks: delete a
  line when you remove its mock, never add one.
- Assert observable behavior or an invariant, not the implementation sequence.
  A test that only proves "does not throw" or re-encodes the production algorithm
  needs a stronger assertion.
- Use snapshots only when the serialized output is itself a stable, reviewable
  contract. Do not use snapshots as a substitute for behavioral assertions.
- Test tenant isolation and ownership-source rules at the
  highest meaningful layer, not only as pure helper tests
- Every bug fix needs a durable guard, but not necessarily an example test:
  prefer types, derivation, schemas, lint rules, or broader invariants when they
  eliminate the bug class
- Guard the invariant, not the accident. Do not memorialize a one-off typo,
  stale literal, or incidental implementation detail in a dedicated test when
  structural coupling makes that failure impossible
- Avoid "tests for tests' sake": don't add shallow examples
  just to increase coverage if a stronger invariant test would
  cover the same surface with more signal
- Run tests through the owning package script so preloads and setup survive:
  `bun run test -- --bail -t "<name>"`. Do not call a raw runner from the
  worktree root when the package script supplies configuration.
- Verify a new regression test fails against the known-bad behavior before
  trusting it. A test that never reaches the fault, or matches zero tests, is
  not a guard.
- Detector and backstop tests use production-shaped inputs the detector can
  actually match. Assert the fixture reaches or differs on the fault boundary
  before asserting the protected outcome.
- Where a map declares paths or cases, assert the declared and exercised sets
  are equal in both directions. Pin fixture literals that stand in for producer
  output with `satisfies` against the producer's return type.
- For systemic bugs, test the class: fixed points for replay, matrices for
  tenant isolation, properties for parsers/normalizers, state-machine
  transitions for lifecycle code, and round trips for serialization.
- Keep time, randomness, network, filesystem, and database ownership explicit
  in tests. Pin or inject them rather than relying on ambient machine state.
- Name the error a throw assertion expects. `expect(...).toThrow()` with no
  argument passes for every error, so it keeps passing once the code fails for
  an unrelated reason; pass a message substring, a regex, or the error class.
  `no-vacuous-throw-assertion` enforces this.

## Mutation check

A test guarding behavior X is finished only once reverting X makes it fail.
Until you have seen it go red against the known-bad behavior, it may be
passing for an unrelated reason. When the test is the evidence for a fix,
say in the PR that you ran the mutation and what it broke.

The usual failure is a fixture the fault cannot reach. Assert the fixture
DIFFERS before asserting the equivalence: check
`expect(NFD(word)).not.toBe(NFC(word))` before asserting both normalize alike,
so a fixture that is already normalized cannot make the test vacuous.

## Cross-runtime contracts

Where one rule lives in two runtimes at once (JavaScript, Postgres, the search
engine), parity is proven only by DERIVING the other side's rules executably:
query the live extension for its token output, render the SQL the query layer
emits and assert on that, read the analyzer's configuration tuple.

A hand-maintained list mirroring the other side's behavior is not evidence of
parity. It is the drift, written down: it agrees with the other runtime exactly
until that runtime changes, and nothing fails when it does.

## Projection census

Any "marked done" flag that mirrors state in an external system (search index,
object store, queue) ships with a reconciler that compares both sides and
reports the difference. Acceptance by the remote system is not durability, so
the flag alone can never prove the projection landed.

Treat the reconciler as part of the feature, not follow-up work: without it the
first divergence is invisible until a user reports missing data.
