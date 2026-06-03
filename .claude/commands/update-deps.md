# Update Dependencies

Review and update third-party dependencies. Use this when asked
to upgrade packages, survey new minor or major releases for
useful features, assess whether Stella can adopt them, or
validate whether a release looks suspicious before bumping it.

## Scope

Default to Bun packages, Cargo crates (Tauri desktop), and
Docker base images. Expand to GitHub Actions when the request
mentions them or the affected files live in `.github/`.

Stella already has automated controls:

- `bunfig.toml` enforces a 5-day minimum release age for
  packages.
- `dependency-review.yml` blocks incompatible licenses and
  high-severity CVEs.
- `sbom.yml` regenerates `sbom.cdx.json` and
  `THIRD-PARTY-NOTICES.txt`.

Do not duplicate those checks manually unless the user asks for
an audit or the automation looks stale or broken.

## Arguments

`$ARGUMENTS` should describe the dependency scope, desired risk
level, and whether to actually apply changes or only prepare a
recommendation.

Helpful extras when available:

- package names, ecosystem, or files
- patch-only, minor, major, or mixed
- whether to optimize for new features, risk reduction, or
  vulnerability remediation

If the request is vague, default to:

1. all outdated dependencies in scope
2. coherent ecosystem-sized batches
3. one commit per validated batch

## Instructions

1. **Establish the version source of truth**:
   - root `package.json` `catalog`, `catalogs`, and `resolutions`
   - workspace `package.json` files
   - `bun.lock`
   - `apps/desktop/src-tauri/Cargo.toml` and `Cargo.lock`
   - `.github/dependabot.yml` for grouping expectations
   - `.github/workflows/*.yml` for GitHub Action pins
   - `apps/api/Dockerfile` for the base image digest

2. **Inventory outdated candidates**:
   - run `bun outdated --filter="*"` for Bun workspace packages
   - run `cargo outdated --root-deps-only` in
     `apps/desktop/src-tauri` for Cargo crates. If `cargo-outdated`
     is missing, prefer `cargo binstall cargo-outdated` (prebuilt
     binary, seconds) over `cargo install cargo-outdated` (compiles
     from source, several minutes). As a fallback, use
     `cargo update --dry-run` plus targeted `cargo search` /
     `cargo info` checks
   - inspect open dependency PRs if the request is about
     triage rather than local edits
   - include GitHub Actions only when the request covers them

3. **Plan the full sweep, then batch it**:
   - cover all outdated dependencies in the requested scope,
     not just the first safe batch
   - split the work into coherent ecosystem or library-family
     batches
   - follow existing Dependabot grouping where possible
   - avoid mixing high-risk majors with routine minors in the
     same commit
   - use one commit per validated batch so rollback stays easy

4. **Classify upgrade risk before touching code**:
   - patch: usually lowest risk
   - minor: check new features and silent behavior changes
   - major: assume migration work
   - `0.x` minor: treat as potentially breaking

5. **Read official upgrade sources**:
   - changelog or release notes
   - migration guide
   - breaking changes
   - peer dependency, engine, runtime, and module-format
     changes

   Prefer official docs, releases, and package metadata over
   blog posts or third-party summaries.

6. **Scan the codebase for adoption opportunities**:
   - search current usage with `rg`
   - look for deprecated APIs, local workarounds,
     compatibility shims, TODOs, or comments the new release
     could remove
   - if a new version unlocks a better pattern, identify the
     concrete files that could adopt it now

7. **Check suspicious-release signals before adopting a fresh version**:
   - start with cheap metadata checks first
   - release age relative to Stella's 5-day quarantine
   - publisher, maintainer, repository, or homepage change
   - missing or unusual git tag or release notes
   - new `preinstall`, `install`, `postinstall`, or
     `prepare` scripts
   - new native binaries or bundled blobs

   Only escalate to tarball and file-tree inspection when the
   metadata looks odd, the package is high risk, or the user
   explicitly wants a supply-chain review. That deeper pass can
   cover:
   - sudden tarball size or file-tree jump
   - obfuscated files
   - package contents that differ materially from prior
     releases without explanation

   For broad sweeps, if subagents are available, delegate the
   deep suspicious-release pass to a smaller background agent
   while the main agent handles changelogs, adoption scan, and
   code changes.

   Good defaults:

   ```bash
   npm view <pkg>@<version> --json
   bun pm untrusted
   ```

   Use tarball inspection when the metadata looks odd or the
   release is high risk.

8. **Apply the change at the real source of truth**:
   - prefer root `catalog`, `catalogs`, or `resolutions`
     updates over per-workspace drift
   - update GitHub Actions by commit SHA, not floating tags
   - keep Docker images pinned by digest
   - for Cargo, prefer `cargo update -p <crate>` when the
     existing semver range already covers the new version;
     edit `Cargo.toml` only when bumping past the range
   - after each batch passes validation, commit that batch
     before moving to the next one

9. **Review the lockfile delta**:
   - use `bun update`, or edit manifests and run `bun install`
   - for Cargo, run `cargo update` and read the `Cargo.lock`
     diff the same way (unexpected transitive additions or
     replacements)
   - read the `bun.lock` diff for unexpected transitive
     additions, dependency replacement, or new script-bearing
     packages
   - if the new tree introduces untrusted packages with
     scripts, inspect them before trusting anything

10. **Validate in layers**:
    - run the smallest focused checks for the affected
      ecosystem first
    - then run repo checks relevant to the touched surfaces
    - for Bun package updates, default to `bun run lint`,
      `bun run typecheck`, and the relevant tests
    - for Cargo updates, run `cargo check` (and `cargo test`
      when crates touch logic, not just deps) in
      `apps/desktop/src-tauri`
    - verify generated artifacts or migrations explicitly when
      the upgraded dependency affects them

11. **Prefer removal and consolidation over passive growth**:
    - if the upgrade makes a local helper, polyfill, or
      wrapper obsolete, remove it
    - if several packages now overlap, prefer the one already
      aligned with the codebase

12. **Report back with**:
    - the full batch plan
    - current and target versions
    - risk level
    - why the upgrade is worth taking now
    - concrete adoption opportunities found in the codebase
    - suspicious-release assessment
    - validation run
    - commit created for each completed batch
    - follow-up work for deferred or blocked majors
