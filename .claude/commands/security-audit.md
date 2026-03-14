# Security Audit

Scan the Stella codebase for security issues. We handle sensitive legal
documents — security is non-negotiable.

## Instructions

1. **Hardcoded secrets** — scan for API keys, tokens, passwords, connection
   strings in source files (not `.env.example` or `.env`):

   Search for patterns like `apiKey`, `secret`, `password`, `token`,
   `credential` assigned to string literals in `apps/` and `packages/`.
   Ignore markdown, example files, and node_modules.

2. **Auth bypass** — verify that every handler in
   `apps/api/src/handlers/` checks authentication. Read each handler's
   route file and confirm auth middleware is applied. Flag any endpoint
   that is publicly accessible without explicit justification.

3. **Ownership via branded types** — every workspace-scoped handler
   must use `createHandler` from `api-handlers.ts`, which provides a
   `WorkspaceHandlerContext` with `workspaceId: SafeId<"workspace">`.
   Flag any handler that:
   - Accepts `workspaceId` from the request body or query params
     instead of the validated context
   - Uses `createRootHandler` when it accesses workspace-scoped data
   - Passes a raw `string` where `SafeId<"workspace">`,
     `SafeId<"organization">`, or `SafeId<"user">` is expected
   - Lacks a `permissions` declaration in its `config`

4. **S3 presigned URLs** — read `apps/api/src/handlers/files/presign.ts`
   and any other presign usage. Check that:
   - Expiration is short (< 15 minutes for uploads, < 1 hour for reads)
   - Workspace ownership is verified before generating presigned URLs
   - No user input is passed unsanitised into S3 key paths (path
     traversal via `../`)

5. **File upload validation** — check that uploaded files are validated
   for type and size before being stored in S3. Verify that file
   metadata (content type, name) from the client is not blindly trusted.

6. **CORS configuration** — read `apps/api/src/index.ts` and check the
   CORS setup. Flag `origin: "*"` or overly permissive origins. Should
   be restricted to your known domains.

7. **Dependency vulnerabilities**:

   ```bash
   bun pm audit
   ```

   Also check the Dependabot alerts:

   ```bash
   gh api repos/{owner}/{repo}/dependabot/alerts --jq '.[].security_advisory.summary'
   ```

8. **AI prompt injection** — check that user-provided content passed to
   the AI SDK (Google Generative AI) is not interpolated directly into
   system prompts. Read the AI integration code in `apps/api/src/` and
   verify that user content is clearly separated from system
   instructions.

9. **Workspace isolation** — handlers must use `scopedDb` (which
   pre-filters by workspace) for all workspace-scoped queries. Flag
   any handler that:
   - Uses the unscoped `db` directly for workspace-scoped tables
   - Constructs ad-hoc `WHERE workspaceId = ...` instead of using
     `scopedDb`
   - Passes workspace IDs across handler boundaries without
     re-validating ownership

10. **Ethical walls (information barriers)** — in law firms, lawyers
    working on opposing sides of a matter (or for competing clients)
    must not have access to each other's documents. Verify that:

- Matter-level access controls exist and are enforced at the query
  level, not just the UI level
- File access checks the user's permission on the specific matter,
  not just workspace membership
- Search results are filtered by matter access — a user must never
  see documents from matters they are not assigned to
- AI features: see check #14 for detailed AI isolation requirements
- Presigned S3 URLs verify matter-level access, not just workspace
  membership
- Audit logs capture who accessed what document and when (for
  compliance evidence)
- If ethical wall / conflict check features exist, verify they
  cannot be bypassed by direct API calls

11. **Auth and session management** — the project uses better-auth with
    organisation support, roles (Owner, Admin, Member), and email OTP.
    Check `apps/api/src/lib/auth.ts` and `apps/api/src/db/auth-schema.ts`.
    Verify that:
    - Session tokens have a reasonable expiration
    - Logout invalidates the session server-side (not just client-side)
    - Role checks (Owner/Admin/Member) are enforced at the API level,
      not just the UI
    - Organisation membership is verified before granting access to
      org resources
    - Invitation tokens are single-use and expire
    - OTP codes have rate limiting and short expiration
    - A user removed from an organisation loses access immediately
      (session is invalidated or next request is rejected)

12. **Data retention and deletion** — when a document or matter is
    deleted, verify that:
    - The file is actually removed from S3, not just the DB reference
      (no orphaned files)
    - Or if soft-delete, that the file is inaccessible via presigned
      URLs and excluded from search/AI context
    - Deletion is logged for GDPR Article 17 compliance (right to
      erasure — ability to prove data was deleted)

13. **Legal privilege leakage** — attorney-client privilege and
    work product doctrine mean document content must never leak
    through side channels:
    - Search indexes, AI embeddings, and analytics events must
      not contain document body text or metadata that reveals
      matter substance
    - Error messages, logs, and stack traces must never include
      document content, file names, or matter names (these can
      reveal case strategy)
    - PDF thumbnails, preview images, and cached renders must
      respect the same access controls as the source document
    - Export and download endpoints must re-check permissions at
      the moment of export, not rely on a stale permission
      grant

14. **Cross-matter data isolation in AI context** — when AI
    features (review, research, chat) build context:
    - The context window must only include documents from
      matters the requesting user has access to
    - AI tool calls (`searchMatter`, `readEntity`, etc.) must
      enforce matter-level permissions per call, not per
      session
    - AI-generated summaries, citations, or comparisons must
      not reference documents from other matters, even if the
      model has seen them in a prior turn
    - Conversation history must be scoped to the user and
      matter; shared threads must not leak one user's queries
      to another

15. **Document versioning integrity** — legal documents require
    an unbroken chain of custody:
    - Version history must be immutable: no endpoint allows
      overwriting or deleting a prior version
    - Version metadata (author, timestamp) must come from the
      server, never from client-supplied values
    - Concurrent edits to the same document must not silently
      overwrite; verify optimistic locking or conflict
      detection is in place

16. **Audit trail completeness** — SOC 2 and ISO 27001 require
    evidence of who did what and when:
    - All document access (view, download, print, share) must
      produce an audit log entry, not just mutations
    - Audit logs must be append-only; no endpoint allows
      deletion or modification of log entries
    - Bulk operations must log each affected resource
      individually, not just "bulk action on N items"
    - Audit log entries must include the actor's IP and
      user-agent for forensic traceability

17. **Sensitive data in logs and errors** — legal data requires
    stricter controls than typical SaaS:
    - Request/error logs must never contain document content,
      file names, matter names, client names, or session tokens
    - Structured logs must not serialize entire request bodies
      (which may contain file contents or PII)
    - Stack traces in production responses must be suppressed
      (return generic error messages to clients)
    - Analytics events (PostHog) must not capture matter names,
      document titles, or any content that could identify a
      client or case

18. **Atomicity on privileged operations** — operations that
    affect access to privileged data must be atomic:
    - Permission revocation (removing a user from a matter or
      workspace) must invalidate all active sessions and
      presigned URLs for that user immediately
    - Role changes must take effect on the next request, not
      after a cache TTL expires
    - Bulk permission changes (e.g., reassigning a matter) must
      be transactional; partial application could leave
      documents accessible to the wrong users

## Output

For each finding, report:

- **Severity**: Critical / High / Medium / Low
- **File and line**: exact location
- **Issue**: what's wrong
- **Fix**: how to resolve it

Group findings by severity. If no issues found in a category, confirm it
passed.

## After Audit

If critical or high severity issues are found, fix them immediately and
create a commit: `fix: address security audit findings`.
