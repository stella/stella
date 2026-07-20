# Data Classification Policy

**Owner:** Engineering
**Last reviewed:** 2026-07-10
**Review cadence:** Annual

## Purpose

Classify the data Stella processes and stores so that
appropriate controls are applied at each level. Stella handles
legal documents that may be subject to attorney-client
privilege, litigation holds, and data-protection regulations.

## Scope

All data stored, processed, or transmitted by the Stella
application: database records, uploaded files, AI-generated
outputs, session tokens, and logs.

## Classification levels

| Level            | Description                                                                                                               | Examples                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Public**       | Material intentionally published or sourced from an official public record.                                               | Public case law, legislation, published catalogue metadata                            |
| **Confidential** | Data protected by legal privilege, privacy law, or a client obligation. Unauthorized disclosure could cause serious harm. | Document contents, entity metadata, AI review results, attorney-client communications |
| **Internal**     | Operational data not intended for public disclosure.                                                                      | User profiles, organization membership, workspace configuration, audit logs           |
| **Secret**       | Credentials and cryptographic material. Exposure leads to immediate compromise.                                           | Session tokens, API keys, S3 credentials, OTP codes, signing keys                     |

All workspace content is treated as Confidential by default, regardless
of whether a source document was previously public.

## Controls by classification

### Confidential (document content)

<!-- evidence: classification-object-storage -->

1. **Workspace isolation.** Primary content tables carry a
   `workspaceId` foreign key or derive their scope through a parent with
   enforced foreign keys. Queries apply tenant predicates before data is
   returned; PostgreSQL RLS provides an independent enforcement layer.

2. **Organization boundary.** The `workspaceAccessMacro`
   verifies that the workspace belongs to the caller's active
   organization before any data is returned.

3. **Encryption in transit.** All client-server communication
   uses TLS. S3 presigned URLs are generated with HTTPS
   endpoints.

4. **Encryption at rest.** Deployed database and S3-compatible storage
   must use provider-side encryption. Extracted document text and stored
   provider credentials additionally use application-layer encryption in
   deployed environments.

5. **Short-lived access.** Presigned URLs for file downloads
   expire after 15 minutes
   (`apps/api/src/handlers/files/get.ts`). URLs are
   generated on demand and never persisted.

6. **Private ACL.** All S3 objects are stored with
   `acl: "private"` (`apps/api/src/lib/s3.ts`). No objects
   are publicly readable.

7. **Hierarchical object keys.** S3 keys follow
   `{organizationId}/{workspaceId}/{fileId}.{ext}`, enforcing
   namespace separation at the storage layer.

### Internal (operational data)

8. **Access-controlled endpoints.** All API endpoints require
   authentication via `authMacro`. Organization membership is
   verified before returning user or workspace metadata.

9. **Logging without leaking.** Application logs capture
   request metadata (actor, timestamp, resource ID) but never
   log document contents, tokens, PII, or file payloads.

### Secret (credentials)

10. **Environment-only storage.** Secrets (database URL, S3
    credentials, API keys) are stored in environment variables,
    never in source code or configuration files.

11. **Local secret scanning.** Developers who install the repository
    Lefthook hooks get a staged Gitleaks scan that
    blocks commits containing candidate credentials or tokens.

12. **No secrets in logs.** Error handlers and logging
    utilities strip sensitive fields before output.

## Enforcement

- Workspace isolation is enforced at both the application
  layer (`workspaceAccessMacro`, `SafeId`) and the database
  layer (FK constraints, scoped indexes).
- Developers who install Lefthook hooks get staged secret
  scanning via Gitleaks before secrets enter Git history.
- S3 ACL and presigned URL expiry are set in code and verified
  during code review.

## Review

This policy is reviewed annually or when new data categories
are introduced (e.g., new AI features processing document
content).
