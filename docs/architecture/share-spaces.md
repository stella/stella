# Share Spaces: Architecture Decision and Threat Model

Date: 2026-07-29

Status: Accepted; secure single-document beta implemented

## Context

Stella needs to share selected legal documents with people who must not receive matter or organization access. The capability must serve a single-document link and grow into a multi-document data room, request list, external submission workflow, and automation surface.

The workspace authorization model is intentionally broad within an authorized matter. Reusing it for guests would make accidental over-disclosure likely, particularly because the existing organization `external` role can read an assigned workspace. Internal file chat also contains private prompts, tool calls, and references that do not belong in an external collaboration channel.

## Decision

### One Share Space primitive

A direct document link is a one-item Share Space. Multi-document rooms, request lists, recipients, and external discussion extend the same resource rather than introducing separate access systems.

### Copy-on-publish snapshots

Publishing pins an exact entity version and copies its original, display derivative, and optional thumbnail into a Share Space-owned S3 prefix. External reads use only copied assets and snapshot metadata.

The source entity, version, and field IDs are retained as provenance without foreign keys. This is deliberate: deleting or retaining a matter document must not silently mutate the already-published bytes, and workspace deletion remains the ownership boundary that cascades the complete Share Space.

### Recipient authentication without membership

Recipients authenticate through Better Auth email OTP and have ordinary user IDs for audit attribution. They are not organization members. An allowlisted `share_recipients` row binds the authenticated user to one Share Space and one role.

The raw invitation token is generated with at least 256 bits of entropy, returned once, and stored only as a SHA-256 hash. After OTP verification, the token is exchanged and removed from the browser URL.

### Dedicated database scope

`createShareScopedDb` activates one server-validated Share Space ID and the authenticated recipient user ID. It explicitly clears organization and workspace settings. Share-table RLS combines the normal internal workspace branch with a narrow external read branch. External scope grants no insert, update, or delete access.

The public OTP request resolves only a hash of a well-formed invitation secret and always returns the same accepted shape. After Better Auth verifies the email, exchange binds that authenticated user to the allowlisted recipient. Every manifest and asset request re-proves the verified user binding, lifecycle, and expiry before activating the Share Space RLS pin.

### Separate external discussion

Internal chat threads are never exposed. A future `share_messages` table will contain only messages deliberately posted to the external surface. Publishing an internal chat requires a reviewed immutable export.

## Trust boundaries

1. **Internal session to management API**: existing organization membership, workspace authorization, and explicit Share Space permissions.
2. **Raw invitation token to OTP gate**: rate-limited hash lookup with non-enumerating responses.
3. **OTP session to recipient binding**: normalized verified email must match an active recipient row.
4. **Recipient binding to share RLS context**: exactly one active, unexpired Share Space is pinned; no workspace or organization scope is set.
5. **Share item to S3**: only copied share-owned keys are signed, with short display/download lifetimes.
6. **External upload to matter**: future submissions remain in a quarantine namespace until scanning and explicit internal acceptance.

## Threats and controls

| Threat                              | Control                                                                                                    | Verification                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Guessed or leaked database IDs      | High-entropy invitation secret plus authenticated recipient binding; external responses use share IDs only | Cross-space and direct-ID integration tests                                 |
| Forwarded invitation link           | OTP is sent only to an allowlisted address                                                                 | Wrong-email and forwarded-link tests                                        |
| Email enumeration                   | Generic request response, dedicated per-IP OTP budget, and Better Auth OTP limits                          | Response-shape, permissive-token-route, and rate-limit tests                |
| Workspace overreach                 | Share DB context clears organization/workspace scope; guest endpoints never call workspace routes          | RLS test shows zero entity/chat/workspace rows                              |
| Later draft becomes visible         | Item stores copied bytes for one exact version                                                             | Publish v3, create v4, assert shared hash unchanged                         |
| Source deletion changes publication | Share storage is independently owned by the Share Space                                                    | Delete/tombstone source, assert snapshot remains until share retention runs |
| Revoked room still serves content   | Active/expiry checks live in RLS and every URL-mint path; URLs are short-lived                             | Revoke between requests and assert no new URL                               |
| Download-policy bypass              | Display uses a PDF derivative and no attachment endpoint; product does not claim DRM                       | Contract tests and honest UI copy                                           |
| S3 scope escalation                 | Separate Share Space key prefix and signing scope; no organization-wide signing                            | Signing-policy unit tests                                                   |
| Token or PII in logs                | Persist token hash only; sanitize request logging; never log email/token/document content                  | Logging regression tests                                                    |
| Malicious recipient upload          | Exact signed size/hash, isolated staging, scanning, filename sanitization, explicit review/import          | Upload mismatch, scanner, and import tests                                  |
| Internal chat disclosure            | Separate external message model; no internal thread ID accepted by sharing APIs                            | Route schema and response tests                                             |

## Lifecycle invariants

- `draft` and `publishing` Share Spaces are never recipient-readable.
- `active` is recipient-readable only before `expiresAt`.
- `revoked` requires `revokedAt`; revocation is terminal in the initial design.
- Expiration is derived from `expiresAt` during authorization rather than relying on a scheduler transition.
- A `ready` item has original and display storage keys plus publication time.
- A `failed` item has a bounded failure code and no publication time.
- A `withdrawn` item has a withdrawal time and cannot mint URLs.
- Recipient verification is created with a user ID and verification time. The durable user ID provenance remains if that Better Auth account is later deleted; it can no longer authenticate.

## Audit events

Management mutations and external access are written to Stella's append-only audit log. OTP recipients use their Better Auth user ID as the actor. Required resources include Share Space, recipient, and item; required events include create, publish, revoke, invite, verify, access, display, download, withdraw, failure, and later submission review.

## Rollout

1. Additive schema, grants, RLS settings, and isolation tests with no routes.
2. Internal single-document publishing and background S3 copy.
3. Recipient authorization, token exchange, and external manifest/view endpoints.
4. Internal and external UI.
5. Multi-document rooms, requests, submissions, discussion, and automation as independent vertical slices.

Rollback of the foundation is application-only: the additive unused tables can remain in place if deployment is rolled back. Destructive cleanup, if ever required, happens in a later reviewed migration.
