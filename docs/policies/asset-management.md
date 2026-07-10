# Asset Management Policy

**Owner:** Engineering
**Last reviewed:** 2026-07-10
**Review cadence:** Annual

## Purpose

Maintain an accurate, up-to-date inventory of all software
components (first-party and third-party) that comprise the
Stella application, enabling rapid assessment of exposure when
new vulnerabilities are disclosed.

## Scope

All runtime dependencies, build-time tooling, GitHub Actions,
and container base images used in the Stella monorepo.

## Controls

### Software Bill of Materials (SBOM)

<!-- evidence: asset-provenance-inventory -->

1. **CycloneDX SBOM.** The shared provenance workflow generates
   machine-readable CycloneDX inventories for the JavaScript workspace
   and the desktop Rust application. Project definitions and output
   locations are declared in `.provenance.yml`; the scheduled
   `provenance-nightly.yml` workflow proposes refreshed artifacts through
   a pull request.

2. **Committed to repository.** SBOMs live under
   `provenance/projects/<project>/sbom.cdx.json`, so a checkout contains
   the reviewed dependency snapshot for each configured project.

3. **Third-party notices.** Per-project notice files live beside the
   SBOMs, with the repository-level aggregate at
   `provenance/THIRD-PARTY-NOTICES.repo.txt`.

### Dependency tracking

<!-- evidence: asset-dependency-quarantine -->

4. **Lockfile as source of truth.** `bun.lock` records exact
   resolved versions for all packages. It is committed to the
   repository and integrity-checked during `bun ci` in the CI
   pipeline.

5. **Dependabot monitoring.** Dependabot tracks four
   ecosystems (`.github/dependabot.yml`):
   - **Bun packages:** weekly checks, grouped by library family.
   - **GitHub Actions:** weekly checks, grouped.
   - **Docker base images:** weekly checks.
   - **Cargo crates:** weekly checks, grouped by runtime family.

   All updates use a five-day cooldown before adoption, aligned with
   Bun's `minimumReleaseAge` quarantine.

6. **Workspace consistency.** `sherif` runs as a `postinstall`
   hook and is available via `bun run lint:ws`. It flags
   version mismatches of the same package across different
   workspace packages in the monorepo.

### Pinning and integrity

7. **GitHub Action SHAs.** All GitHub Actions in CI workflows
   are referenced by full commit SHA rather than mutable tags,
   preventing supply-chain attacks via tag reassignment.

8. **Docker digest pinning.** The base image in
   `apps/api/Dockerfile` is pinned by SHA-256 digest
   (e.g., `oven/bun:1.3.9-slim@sha256:...`), ensuring builds
   are reproducible and immune to tag mutation.

9. **Non-root container.** The production Docker image runs
   as a dedicated non-root user (`stella`, UID 1001).

### License compliance

10. **Dependency review.** The `dependency-review.yml` workflow
    blocks PRs that introduce dependencies under copyleft or
    proprietary licenses incompatible with stella's Apache-2.0
    distribution and commercial-license arrangements. The deny
    list covers GPL, AGPL, LGPL, SSPL, BUSL, Elastic, and CPAL
    license families.

## Enforcement

- Provenance refreshes are proposed automatically and remain reviewable
  as ordinary repository changes.
- `sherif` runs on every `bun install`, catching version drift
  before it reaches CI.
- Dependency review is a required status check on `main`;
  non-compliant licenses block merging.
- Pinned SHAs and digests are verified during code review of
  workflow changes.

## Review

This policy is reviewed annually or when new ecosystems
(e.g., a new runtime, package manager, or container registry)
are introduced.
