# Security Tests

Tests in this directory verify security invariants that protect
tenant isolation and access control boundaries. They exist to
catch regressions that could violate SOC 2 Type II controls
(particularly CC6: Logical and Physical Access Controls).

## What is tested

### `exempt-route-guards.test.ts`

Every handler route file is covered by the `require-safe-route-handlers`
oxlint rule except the ~17 listed in its `oxlint.config.ts` override
(public/protocol/auth/dev/SSE surfaces that do not fit the safe-handler
config shape). This test is the independent check for exactly that
exempt set, which the live lint rule cannot see:

- Compares the oxlint override's file list against a checked-in expected
  list, so the exemption cannot grow silently.
- Scans each exempt file for mutation endpoints (`.post`/`.put`/`.patch`/
  `.delete` with a string-literal path) and requires each one to be a
  reviewed, checked-in allowlist entry. A staleness check ensures
  allowlist entries still correspond to real endpoints.

### `write-handler-permission-coverage.test.ts`

Static census over every `{ config, handler }` endpoint in the handler
tree (via the shared `discoverSafeHandlers` enumerator): a handler must
carry a `permissions` grant beyond `workspace:["read"]` — the baseline
every member, including the lowest-privileged role, already holds —
unless it affirms `access: "read"` and meters no AI. The read side is an
affirmation, not an inference, so a mutating handler cannot leave the
census by declaring nothing; metering under any `requiresUsage.actionType`
keeps a handler in it. The one exit is a `// permissions-exempt: <reason>`
comment in the handler file, for a reviewed exception (e.g. a write that
reaches nothing but the caller's own row). The assertion is that the
offender set is empty.

### `case-law-research-permissions.test.ts`

The organization's case-law question columns sit behind the
`caseLawResearch` grant. Pins the declared grant per endpoint, checks the
set of endpoints under `handlers/case-law/research/` is fully covered,
and drives the real handlers as each role: a role without the grant gets
403 from the framework before any database work.

### `own-work-permissions.test.ts`

The writes a member makes to their own work — a mark on a decision
(`legalReaderAnnotation`), a stored search (`savedSearch`), a link between
their account and an outside system (`integration`: MCP connections, a
SharePoint sign-in, an agent client, a desktop registry key). Pins the
declared grant per endpoint, checks the sibling reads stay on the
baseline grant while affirming `access: "read"`, and drives the real
handlers as an external collaborator: the role that holds no write grant
anywhere gets 403 from the framework before any database work.

### `branded-types.test.ts`

Validates that the `SafeId<T>` branded type system enforces:

- `toSafeId` produces values usable in typed contexts.
- Plain strings cannot satisfy `SafeId<T>` at the type level,
  preventing accidental use of unvalidated IDs in queries.
- `SafeId<"organization">` and `SafeId<"workspace">` are not
  interchangeable, preventing cross-tenant data access through
  type confusion.

### `sse-auth-invariants.test.ts`

Static analysis test that verifies SSE connections do not carry
bearer/session credentials in URL query strings. EventSource must
use cookie credentials, and SSE handlers must not authenticate
from `query.token`.

### `cross-tenant-handlers.test.ts`

Runtime handler invariant test that exercises real Drizzle queries
through the scoped PGlite fixture. Each registered case authenticates
as tenant A, supplies a tenant B resource ID through the handler's
request-shaped params/query/body, and asserts the response is denied
or empty. This complements static ownership-source linting and lower
level RLS tests by verifying the user-facing handler cannot leak a
cross-tenant resource through a missing workspace or organization
predicate.

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
