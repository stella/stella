# Change Management Policy

**Owner:** Engineering
**Last reviewed:** 2026-02-22
**Review cadence:** Annual

## Purpose

Ensure that all changes to Stella's source code, dependencies,
and infrastructure follow a documented, reviewable, and
auditable process that minimises the risk of introducing
defects or security vulnerabilities.

## Scope

All changes to the `stella/stella` repository, including
application code, database schema, CI workflows, dependencies,
and documentation.

## Controls

### Pull request workflow

1. **Branch-based development.** All changes are made on
   feature branches and submitted as pull requests against
   `main`. Direct commits to `main` are blocked by the branch
   protection ruleset.

2. **Required review.** Every PR requires at least one
   approval from a code owner defined in `CODEOWNERS`. The
   ruleset dismisses stale approvals when new commits are
   pushed and requires the last push to be approved by someone
   other than the author.

3. **Thread resolution.** All review conversation threads must
   be resolved before a PR can be merged.

4. **Conventional Commits.** Commit messages follow the
   Conventional Commits specification (`feat:`, `fix:`,
   `chore:`, `docs:`). PR titles are validated by the
   `pr-lint.yml` workflow.

5. **Contributor License Agreement.** External contributors
   must sign a CLA before their PR is eligible for merge,
   enforced by the `cla.yml` workflow.

### Automated checks (CI gate)

The `ci.yml` workflow runs on every PR and produces a single
`ci-result` status check that gates merging. The pipeline
includes:

| Check              | Tool                      | Purpose                                |
| ------------------ | ------------------------- | -------------------------------------- |
| Spell check        | codespell                 | Catch typos in code and docs           |
| Dependency install | `bun ci`                  | Verify lockfile integrity              |
| i18n sync          | `bun run i18n:check`      | Ensure translation keys are consistent |
| Lint               | oxlint (ultracite preset) | Code quality and security rules        |
| Custom lint rules  | oxlint JS plugins         | Semantic tokens, RTL, ownership IDs    |
| Format             | Prettier                  | Consistent code formatting             |
| Type check         | TypeScript strict mode    | Type safety                            |
| Tests              | Bun test runner           | Functional correctness                 |

All checks must pass. The `ci-result` aggregation job
(`if: always()`) ensures the gate is never accidentally
skipped.

### Dependency changes

6. **Dependency review.** The `dependency-review.yml` workflow
   runs on every PR and blocks introduction of dependencies
   with high-severity CVEs or incompatible licenses (GPL,
   AGPL, LGPL, SSPL, BUSL, Elastic, CPAL).

7. **Automated updates.** Dependabot submits PRs for outdated
   dependencies daily (Bun packages), weekly (GitHub Actions,
   Docker images). Updates are subject to a 3-day cooldown
   before adoption.

8. **Workspace consistency.** `sherif` runs as a `postinstall`
   hook to flag version mismatches across monorepo packages.

### Database schema changes

9. **Dedicated ownership.** Schema files
   (`apps/api/src/db/schema.ts`, `schema-validators.ts`)
   require review from the designated schema owner
   per `CODEOWNERS`.

10. **Migration via Drizzle.** Schema changes are applied
    through `bun run db:push` (Drizzle ORM). Raw SQL is
    avoided unless strictly necessary.

### Sensitive path protection

11. **CI and workflow changes.** Modifications to
    `.github/` require admin review per `CODEOWNERS`.

## Enforcement

- The branch protection ruleset
  (`.github/branch-protection/ruleset-main.json`) makes
  `ci-result` and `dependency-review` required status checks
  in strict mode: PRs cannot be merged unless checks pass on
  the exact commit being merged.
- A weekly audit workflow (`audit-branch-protection.yml`)
  verifies that the live ruleset matches the expected
  configuration.
- Signed commits are required on `main`.

## Review

This policy is reviewed annually. Changes to the CI pipeline
or branch protection rules trigger an ad-hoc review.
