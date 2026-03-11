# Data Classification Policy

**Owner:** Engineering
**Last reviewed:** 2026-02-22
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

| Level            | Description                                                                                        | Examples                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Confidential** | Data protected by legal privilege or regulation. Unauthorized disclosure could cause serious harm. | Document contents, entity metadata, AI review results, attorney-client communications |
| **Internal**     | Operational data not intended for external disclosure.                                             | User profiles, organization membership, workspace configuration, audit logs           |
| **Secret**       | Credentials and cryptographic material. Exposure leads to immediate compromise.                    | Session tokens, API keys, S3 credentials, OTP codes, signing keys                     |

Stella does not process or store public-tier data in normal
operation; all workspace content is treated as Confidential
by default.

## Controls by classification

### Confidential (document content)

1. **Workspace isolation.** Primary content tables (`entities`,
   `files`, `properties`, `views`) carry a `workspaceId`
   foreign key with a cascade-delete constraint. Dependent
   tables (`entityVersions`, `fields`, `justifications`) are
   isolated transitively via their parent records. Queries are
   scoped by `workspaceId`, never filtered in application code
   after fetching.

2. **Organization boundary.** The `workspaceAccessMacro`
   verifies that the workspace belongs to the caller's active
   organization before any data is returned.

3. **Encryption in transit.** All client-server communication
   uses TLS. S3 presigned URLs are generated with HTTPS
   endpoints.

4. **Encryption at rest.** S3 objects use server-side
   encryption (SSE). The database uses encrypted storage
   volumes.

5. **Short-lived access.** Presigned URLs for file downloads
   expire after 15 minutes
   (`apps/api/src/handlers/files/read-by-id.ts`). URLs are
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

11. **Lint enforcement.** oxlint's `no-secrets` rule (entropy
    threshold 50) runs in CI and blocks commits containing
    high-entropy strings that resemble credentials.

12. **No secrets in logs.** Error handlers and logging
    utilities strip sensitive fields before output.

## Enforcement

- Workspace isolation is enforced at both the application
  layer (`workspaceAccessMacro`, `SafeId`) and the database
  layer (FK constraints, scoped indexes).
- CI checks (`ci-result`) include linting rules that detect
  secrets in source.
- S3 ACL and presigned URL expiry are set in code and verified
  during code review.

## Review

This policy is reviewed annually or when new data categories
are introduced (e.g., new AI features processing document
content).
