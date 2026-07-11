# Access Control Policy

**Owner:** Engineering
**Last reviewed:** 2026-07-10
**Review cadence:** Annual, or after any access-related incident

## Purpose

Define the controls that restrict access to Stella's systems,
data, and source code to authorized individuals operating at the
minimum privilege level required for their role.

## Scope

This policy covers application-level access control, repository
access, and CI/CD pipeline permissions. Infrastructure-level
IAM and network controls are documented separately in the
operations runbook (private).

## Controls

### Application layer

<!-- evidence: access-auth-boundary -->

1. **Authentication.** All API requests are authenticated via
   `better-auth` with session tokens. The `authMacro`
   (`apps/api/src/lib/auth.ts`) validates the session and
   resolves the active organization before any handler runs.

2. **Organization scoping.** Each session tracks an
   `activeOrganizationId`. The `better-auth` organization
   plugin manages membership, roles, and invitations. Users
   can only operate within organizations they belong to.

3. **Workspace authorisation.** The `workspaceAccessMacro`
   (`apps/api/src/lib/auth.ts`) runs on every
   workspace-scoped endpoint. It verifies: (a) the workspace
   exists and is active; (b) the workspace belongs to the
   caller's active organization. Requests that fail either
   check receive a 403 or 404 with no data leakage.

4. **Branded ownership IDs.** The `SafeId` branded type
   (`apps/api/src/lib/branded-types.ts`) enforces at compile
   time that workspace and organization IDs passed to
   business logic have been validated by the macro. Ownership
   IDs are never accepted from client-supplied request bodies.

5. **Tenant isolation in storage.** Workspace file object keys follow the
   pattern `{organizationId}/{workspaceId}/{fileId}.{ext}`,
   ensuring namespace-level separation. All objects use a
   `private` ACL. Upload URLs expire after five minutes; normal
   file-read and download URLs expire after 15 minutes.

### Repository and CI/CD

<!-- evidence: access-branch-protection -->

6. **Branch protection.** The `main` branch is protected by a
   GitHub ruleset (`.github/branch-protection/ruleset-main.json`)
   that enforces:
   - No direct pushes; all changes via pull request.
   - At least one approval; matching sensitive paths additionally
     require their code owner.
   - Stale reviews dismissed on new pushes.
   - Last-push approval required (author cannot self-approve).
   - All review threads resolved before merge.
   - Required status checks: `ci-result`, `dependency-review`.
   - Signed commits required.
   - No force pushes or branch deletion.

7. **Code ownership.** `CODEOWNERS` designates owners for sensitive
   paths, including CI/release automation, database code and migrations,
   authentication, dependency manifests, and privileged desktop code.

8. **Fork trust gate.** The CI workflow
   (`.github/workflows/ci.yml`) skips checks on fork PRs
   until a maintainer applies the `run-ci` label, preventing
   untrusted code from executing in CI.

9. **Ruleset audit.** A weekly workflow
   (`audit-branch-protection.yml`) compares the live GitHub
   ruleset against the checked-in expected configuration and
   alerts on drift.

## Enforcement

- Workspace-scoped handlers use `createSafeHandler`, whose authorized
  context requires the `SafeId<"workspace">` minted by
  `workspaceAccessMacro`; security invariant tests cover route and RLS
  enforcement.
- Branch protection rules are enforced by GitHub and audited
  weekly.
- Lefthook's staged Gitleaks scan helps block commits
  containing tokens or credentials before they are written to
  Git history.

## Review

This policy is reviewed annually by the engineering lead.
Ad-hoc reviews are triggered by access-related incidents,
changes to the authentication stack, or organizational
restructuring.
