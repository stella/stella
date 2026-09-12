# Plan: Share Spaces and Data Rooms

Date: 2026-07-29

## Progress

- [x] Foundation: ADR/threat model, schema, additive migration, dedicated share RLS scope, and adversarial isolation tests.
- [x] Secure single-document publishing: permission resource, management handler, snapshot copy job, and audit events.
- [x] Recipient access: non-enumerating OTP request, authenticated token exchange, per-request recipient authorization, external manifest/item URLs, and audit events.
- [x] Beta UI: document-row publishing dialog, durable workspace management/revocation page, token-free external viewer route, and optional original download.
- [ ] Multi-document room, requests/submissions, external discussion, and automation slices.

## Goal

Add an email-gated external sharing boundary for immutable document-version snapshots. The same Share Space primitive will support one-document links, multi-document data rooms, external requests, and reviewed submissions without granting workspace access.

## Design Decisions

- **One Share Space primitive**: a document link is a one-item Share Space; a data room is a multi-item Share Space.
- **Published snapshots**: copy original and display assets into share-owned storage so later drafts and workspace mutations cannot change external content.
- **OTP recipients, no organization membership**: recipients are Better Auth users authorized only by recipient rows; the existing `external` organization role is intentionally not used.
- **Dedicated share RLS scope**: external transactions carry one validated Share Space ID and no workspace IDs.
- **Separate external discussion**: never expose internal AI/file chat; messages are explicitly external and share-scoped.
- **Review before import**: future recipient uploads remain quarantined until an internal user accepts them into the matter.

## Scope

**Implemented in the single-document beta:**

- ADR and threat model.
- Additive schema for Share Spaces, recipients, and immutable document items.
- RLS and authorization boundary with public OTP/access routes.
- Lifecycle, tenant, recipient, and snapshot invariants.
- Focused security and schema tests.
- Internal publication/status/revocation and external snapshot viewer UI.

**Still out of scope:**

- Anonymous links.
- Recipient uploads and request lists.
- NDA clickwrap, watermarking, or DRM claims.
- Sharing internal chat threads.

## Implementation

- `docs/architecture/share-spaces.md` — decision record and threat model.
- `apps/api/src/db/schema/sharing.ts` — Share Space, recipient, and item tables with lifecycle constraints and indexes.
- `apps/api/src/db/schema.ts` and `apps/api/src/db/schema/relations.ts` — schema registration and relations.
- `apps/api/src/db/rls.ts` — Share Space setting and policy helpers.
- `apps/api/src/db/scoped.ts` — narrowly typed share-scoped transaction wrapper.
- `apps/api/drizzle/.../migration.sql` — additive tables, indexes, grants, and RLS policies.
- `apps/api/src/tests/security/` — adversarial isolation and schema-invariant coverage.
- Recipient control-plane queries live behind `lib/share-space-access.ts`; handlers cannot import owner database handles.
- Internal APIs live below `/v1/workspaces/:workspaceId/share-spaces`; recipient APIs live below `/v1/share-spaces/access`.
- Frontend entry is `/share/:invitationSecret`; successful exchange replaces it with token-free `/shared/:shareSpaceId`.

## Test Cases

- Workspace-scoped users cannot manage Share Spaces in inaccessible matters.
- A share-scoped transaction sees only its validated Share Space.
- Share scope grants no visibility into workspace/entity/chat tables.
- Recipient access requires matching authenticated user, active recipient, active space, and non-expired space.
- Cross-space and cross-organization IDs fail closed.
- Token material is stored only as a hash.
- Document item references a fixed entity version and records immutable asset metadata.
- Delete and lifecycle foreign-key behavior cannot silently orphan storage references.

## Open Questions

- Final retention window for revoked Share Space snapshots.
- Whether organization branding is exposed before OTP verification.
