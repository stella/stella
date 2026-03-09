# Security Tests

Tests in this directory verify security invariants that protect
tenant isolation and access control boundaries. They exist to
catch regressions that could violate SOC 2 Type II controls
(particularly CC6: Logical and Physical Access Controls).

## What is tested

### `permission-guards.test.ts`

Static analysis test that scans all handler route files for
mutation endpoints (PUT, POST, PATCH, DELETE) and verifies each
one has a `permission(...)` guard in its options object.

- Discovers route files automatically from `handlers/*/routes.ts`.
- Parses mutation calls with a regex, then scans forward for a
  `permission` call in the options window.
- An allowlist covers intentionally unguarded endpoints (dev-only
  routes, read-like POSTs). Adding to the allowlist requires code
  review.
- A staleness check ensures allowlist entries still correspond to
  real endpoints, preventing forgotten exemptions.

### `branded-types.test.ts`

Validates that the `SafeId<T>` branded type system enforces:

- `toSafeId` produces values usable in typed contexts.
- Plain strings cannot satisfy `SafeId<T>` at the type level,
  preventing accidental use of unvalidated IDs in queries.
- `SafeId<"organization">` and `SafeId<"workspace">` are not
  interchangeable, preventing cross-tenant data access through
  type confusion.

## Why these tests matter

The `SafeId` branded type and env validation schema are the
foundation of Stella's access control model. The `authMacro`
produces a `SafeId<"organization">` only after session
validation, and `workspaceAccessMacro` produces a
`SafeId<"workspace">` only after verifying the workspace
belongs to the session's organization. If these boundaries
are weakened (e.g., by removing the brand, accepting empty
secrets, or allowing type coercion), tenant isolation breaks.

## Running

```bash
bun test apps/api/src/tests/security/
```
