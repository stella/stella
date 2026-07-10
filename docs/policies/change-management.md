# Change Management Policy

**Owner:** Engineering
**Last reviewed:** 2026-07-10
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

2. **Required review.** Every PR requires at least one approval.
   Changes matching sensitive paths in `CODEOWNERS` additionally require
   approval from that owner. The ruleset dismisses stale approvals when
   new commits are pushed and requires the last push to be approved by
   someone other than the author.

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

<!-- evidence: change-ci-gate -->

The `ci.yml` workflow runs on every PR and produces a single
`ci-result` status check that gates merging. The pipeline
includes:

| Check              | Tool                      | Purpose                                |
| ------------------ | ------------------------- | -------------------------------------- |
| Dependency install | `bun ci`                  | Verify lockfile integrity              |
| i18n sync          | `bun run i18n:check`      | Ensure translation keys are consistent |
| Lint               | oxlint (ultracite preset) | Code quality and security rules        |
| Custom lint rules  | oxlint JS plugins         | Semantic tokens, RTL, ownership IDs    |
| Format             | oxfmt                     | Consistent code formatting             |
| Type check         | TypeScript native preview | Type safety                            |
| Tests              | Bun test runner           | Functional correctness                 |
| Policy evidence    | Repository guard          | Policy-to-implementation drift         |

All checks must pass. The `ci-result` aggregation job
(`if: always()`) ensures the gate is never accidentally
skipped.

### Dependency changes

6. **Dependency review.** The `dependency-review.yml` workflow
   runs on every PR and blocks introduction of dependencies
   with high-severity CVEs or copyleft licenses incompatible
   with Apache-2.0 distribution (GPL, AGPL, LGPL, SSPL, BUSL,
   Elastic, CPAL).

7. **Automated updates.** Dependabot submits PRs for outdated
   dependencies weekly (Bun packages, GitHub Actions, and
   Docker images). Updates are subject to a five-day cooldown
   before adoption.

8. **Workspace consistency.** `sherif` runs as a `postinstall`
   hook to flag version mismatches across monorepo packages.

### Database schema changes

<!-- evidence: change-migration-gate -->

9. **Dedicated ownership.** Database code, modular schema files, and
   migration files require review from their designated owner per
   `CODEOWNERS`.

10. **Migration via Drizzle.** Production schema changes ship as
    immutable migrations under `apps/api/drizzle/` and are applied with
    `bun run db:migrate`. CI checks schema coverage, SQL safety, fresh
    application, and parity with the declarative Drizzle schema.

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
