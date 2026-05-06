# Vendor and Third-Party Management Policy

**Owner:** Engineering
**Last reviewed:** 2026-05-01
**Review cadence:** Annual

## Purpose

Define the controls that govern the selection, onboarding, and
ongoing monitoring of third-party software dependencies and
service providers integrated into Stella.

## Scope

All third-party code that ships with or runs alongside Stella:
npm packages, GitHub Actions, Docker base images, and external
service SDKs (AI providers, email, analytics, storage).

## Controls

### Dependency selection

1. **License compatibility.** New dependencies must carry a
   permissive license compatible with Apache-2.0 distribution.
   The `dependency-review.yml` workflow enforces a deny list of
   27 SPDX identifiers covering GPL, AGPL, LGPL, SSPL, BUSL,
   Elastic, and CPAL license families. Absorbing copyleft
   dependencies would force their terms onto stella as a whole
   and foreclose commercial-license arrangements. Permitted
   licenses include MIT, Apache-2.0, BSD variants, ISC, 0BSD,
   BlueOak-1.0.0, Unlicense, CC0-1.0, CC-BY-4.0, MIT-0,
   MPL-2.0, Python-2.0, and Zlib.

2. **Vulnerability posture.** The same dependency review
   workflow blocks PRs that introduce dependencies with
   known vulnerabilities rated HIGH or above.

3. **Minimal surface area.** Dependencies are added only when
   they provide clear value over a simple in-house
   implementation. The project guidelines require dependency
   hygiene: keep dependencies minimal, pinned, and audited.

### Supply-chain integrity

4. **Pinned versions.** All GitHub Actions are referenced by
   full commit SHA in workflow files. The Docker base image is
   pinned by SHA-256 digest. npm dependencies are locked via
   `bun.lock`.

5. **Cooldown period.** Dependabot is configured with a 3-day
   cooldown (`open-pull-requests-limit` and schedule
   settings in `.github/dependabot.yml`) before proposing
   updates, reducing exposure to compromised releases that
   are quickly retracted.

6. **Automated updates.** Dependabot submits PRs for outdated
   dependencies on a defined cadence: daily for runtime
   packages, weekly for GitHub Actions and Docker images.
   Updates pass through the same CI gate as any other PR.

### Inventory and transparency

7. **SBOM.** A CycloneDX 1.6 SBOM (`sbom.cdx.json`) is
   generated on every dependency change and committed to the
   repository, providing a machine-readable inventory of all
   third-party components with PURLs and license metadata.

8. **Third-party notices.** `THIRD-PARTY-NOTICES.txt` contains
   the full license text of every dependency, regenerated
   automatically alongside the SBOM.

9. **Dependency grouping.** Dependabot groups related packages
   (e.g., TanStack, TipTap, Drizzle, Elysia) into single PRs,
   reducing update noise while maintaining visibility.

### Ongoing monitoring

10. **OpenSSF Scorecard.** The repository is evaluated weekly
    against OpenSSF best practices (`scorecard.yml`),
    covering dependency update tooling, branch protection,
    signed commits, and other supply-chain hygiene signals.

11. **CodeQL.** Weekly static analysis includes checks for
    insecure use of third-party APIs.

### Provider abstraction

12. **AI provider independence.** AI features use the Vercel
    AI SDK, which abstracts the underlying model provider.
    The provider is selectable via configuration, enabling
    failover or migration without rewriting business logic.

13. **Storage abstraction.** File storage uses the S3 API,
    compatible with multiple providers (AWS S3,
    Cloudflare R2, MinIO for self-hosting).

## Enforcement

- `dependency-review` is a required status check on `main`;
  PRs introducing blocked licenses or high-severity CVEs
  cannot merge.
- SBOM generation is automated; no manual inventory
  maintenance is required.
- Pinned SHAs and digests are reviewed during workflow PR
  review; `CODEOWNERS` assigns `.github/` changes to an admin
  reviewer.
- Scorecard results are visible in the GitHub Security tab.

## Review

This policy is reviewed annually or when a new third-party
service or dependency ecosystem is introduced. Ad-hoc reviews
are triggered by supply-chain security incidents affecting
any dependency in the SBOM.
