# Asset Management Policy

**Owner:** Engineering
**Last reviewed:** 2026-02-22
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

1. **CycloneDX SBOM.** A machine-readable SBOM
   (`sbom.cdx.json`) is generated on every push to `main`
   that modifies `bun.lock` or any `package.json`. The
   `sbom.yml` workflow uses `@cyclonedx/cdxgen` to produce a
   CycloneDX 1.6 inventory of all dependencies with package
   URLs (PURLs) and license metadata.

2. **Committed to repository.** The SBOM is committed directly
   to the repo so that any point-in-time checkout includes a
   complete dependency snapshot. Build artifacts are also
   uploaded with 365-day retention.

3. **Third-party notices.** The `THIRD-PARTY-NOTICES.txt` file
   is regenerated alongside the SBOM using
   `generate-license-file`, providing full license texts for
   all dependencies. This file is committed to the repository.

### Dependency tracking

4. **Lockfile as source of truth.** `bun.lock` records exact
   resolved versions for all packages. It is committed to the
   repository and integrity-checked during `bun ci` in the CI
   pipeline.

5. **Dependabot monitoring.** Dependabot tracks three
   ecosystems (`.github/dependabot.yml`):
   - **Bun packages:** daily checks, grouped by library family
     (TanStack, Vite, React, Prettier, AI, PostHog, TipTap,
     AWS, Drizzle, Elysia, RivetKit, oxlint, and others).
   - **GitHub Actions:** weekly checks, grouped.
   - **Docker base images:** weekly checks.

   All updates use a 3-day cooldown before adoption. Bun
   updates ignore patch-level changes (minor and major only).

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

- The SBOM is regenerated automatically; manual updates are
  not required.
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
