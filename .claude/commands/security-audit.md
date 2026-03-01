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

3. **Ownership check** — handlers that access resource-scoped data must
   verify that the user is authorized to access that resource (e.g. via
   org/workspace membership) before granting access. Flag any endpoint
   that lacks an explicit ownership or authorization check.

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

9. **Workspace isolation** — verify that database queries in handlers
   always filter by workspace ID. A user in workspace A must never be
   able to read/modify data from workspace B. Read each handler and
   check that workspace scoping is applied to every query.

10. **Ethical walls (information barriers)** — in law firms, lawyers
    working on opposing sides of a matter (or for competing clients)
    must not have access to each other's documents. Verify that:

- Matter-level access controls exist and are enforced at the query
  level, not just the UI level
- File access checks the user's permission on the specific matter,
  not just workspace membership
- Search results are filtered by matter access — a user must never
  see documents from matters they are not assigned to
- AI features (review, research) scope their context to matters
  the requesting user has access to — no cross-matter data leakage
  through AI prompts or responses
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
