---
name: update-deps
description: "Inventory, assess, update, and validate third-party dependencies across Bun, Python/uv, Cargo, Docker, and GitHub Actions without hiding ecosystem or supply-chain risk."
---

# Update Dependencies

Review or update the dependency scope requested by the user. Discover the
repository's actual manifests and source-of-truth files before running ecosystem
commands; do not assume they live at the root.

## 1. Resolve Scope and Sources of Truth

Inspect repository instructions, workspace manifests, lockfiles, dependency
catalogs or resolutions, automated update configuration, and open dependency PRs
when relevant. Common sources include:

- `package.json`, workspace manifests, `bun.lock`, and `bunfig.toml`
- every relevant `pyproject.toml`, `uv.lock`, and Python constraints file
- every relevant `Cargo.toml` and its `Cargo.lock`
- `Dockerfile*` and Compose YAML
- `.github/workflows/*` and dependency-update configuration

Default to an inventory and recommendation unless the user asks to apply updates.
When applying a broad sweep, split it into coherent, independently validated
batches. Give every major and heavy minor its own validated batch and commit. A
heavy minor is a minor whose official release notes require migration or whose
application requires source, configuration, or schema changes beyond dependency
manifests and lockfiles.

"Separate" means its own batch and commit, not its own pull request and not
omitted. An applied sweep covers every applicable update within the requested
scope and each dependency's intended registry channel. Keep stable dependencies
on stable releases. Include prerelease updates only within an explicitly selected
prerelease channel. The only reason to leave a version behind is a mechanical
block: a release still inside the repository's release-age quarantine, a peer or
engine constraint that cannot be satisfied, or an upstream break with no
migration path. Report each block with its reason. Upgrade size, review burden,
and "risky major" are not blocks.

For every major and heavy minor, read the official release notes for capabilities
worth adopting, not only for breakage. Report the relevant migration details and
capabilities adopted or identified with the version moves.

## 2. Inventory the Full Requested Surface

Run Bun inventory from the workspace root:

```bash
bun outdated --filter="*"
```

For each relevant Rust manifest, inspect the full dependency graph:

```bash
cargo outdated --manifest-path <path/to/Cargo.toml>
```

If `cargo-outdated` is unavailable, preview compatible lockfile updates with:

```bash
cargo update --manifest-path <path/to/Cargo.toml> --dry-run
```

This dry run is an incomplete inventory: it cannot surface releases outside the
manifest's current version requirements. Supplement it with registry-aware
`cargo info` or `cargo search` checks for every direct dependency in scope, and
report the limitation. Do not default to `--root-deps-only` when
`cargo-outdated` is available: transitive changes can carry the material risk.

For each uv-managed Python project, inspect direct and transitive packages:

```bash
uv tree --project <path> --locked --outdated
```

Also compare every direct dependency's declared constraint with authoritative
PyPI metadata. `uv tree --outdated` can hide a newer release when the current
constraint excludes it, so it is not a complete major-version inventory by
itself. Keep accelerator packages and their container runtime in one compatibility
batch: verify the Python wheel's CUDA/ROCm requirements against the selected base
image and exercise a native-library import or linkage smoke test.

Inventory container references across Dockerfiles and Compose files:

```bash
rg -n '^\s*(FROM|image:)\s+' \
  --glob 'Dockerfile*' \
  --glob '*compose*.yml' \
  --glob '*compose*.yaml' \
  --glob '!node_modules/**'
```

Resolve current tags and digests from authoritative registry metadata. Inspect
GitHub Actions when requested or when workflow files are in scope.

Flag exact prerelease pins and non-stable channels separately. Package-manager
"latest" output can miss a newer alpha, beta, rc, next, canary, or dev release on
the intended channel. Query registry tags and compare the deliberate channel.

## 3. Assess Upgrade and Supply-Chain Risk

Treat patch, minor, major, pre-1.0 minor, and prerelease moves according to their
actual compatibility risk. Read official release notes, migration guides, engine
or peer requirements, image notes, and package metadata. Search current usage for
deprecated APIs, compatibility shims, and workarounds the release could remove.

Before adopting a fresh or high-risk release, inspect cheap signals first:

- release age relative to repository quarantine policy
- publisher, maintainer, repository, or homepage changes
- missing tags or unexplained release notes
- new lifecycle scripts, native binaries, or bundled blobs
- image provenance, supported platforms, and digest movement

Use package tarball or image-layer inspection only when those signals are odd, the
dependency is high risk, or the user requested a deeper audit. Prefer official
sources and registry metadata over third-party summaries.

## 4. Apply Deliberate Updates

Update the real source of truth: a shared catalog or resolution before duplicating
versions across workspaces. Preserve the intended prerelease channel explicitly;
do not use a flag that silently replaces it with stable latest.

For Bun versions already allowed by the manifest, update only the planned
packages:

```bash
bun update <package>
```

When a shared catalog owns the version, edit that catalog and run `bun install`
instead of creating workspace drift. Use `bun update <package> --latest` only
when intentionally changing the declared dependency range. Resolve and preserve
an intended prerelease version or channel explicitly.

For Rust, use targeted lockfile updates:

```bash
cargo update --manifest-path <path/to/Cargo.toml> -p <crate>
```

Edit the manifest only when the declared requirement must change. Do not run bare
`cargo update` for an ordinary batch; a full-graph update must be an explicit,
reviewed choice.

For uv, update only the planned packages and review the resulting lockfile:

```bash
uv lock --project <path> --upgrade-package <package>
uv sync --project <path> --frozen
```

Edit `pyproject.toml` when intentionally widening or changing a direct dependency
constraint. Do not run an unscoped full Python upgrade unless the batch explicitly
covers the full Python graph.

Pin GitHub Actions to commit SHAs and container images to immutable digests when
that is repository policy. Review every manifest and lockfile delta for unexpected
transitive additions, replacements, features, scripts, or platform changes.

Prefer removal over passive growth: delete obsolete shims, polyfills, or duplicate
packages when the upgrade makes them unnecessary and the validation surface remains
focused.

## 5. Validate and Report

Run the smallest affected checks first, then the repository's canonical
verification for the touched surface. Use each Rust command with its actual
manifest path, for example:

```bash
cargo check --manifest-path <path/to/Cargo.toml>
cargo test --manifest-path <path/to/Cargo.toml>
```

Use each Python command against its actual project and locked environment, for
example:

```bash
uv lock --project <path> --check
uv run --project <path> --locked <lint-or-test-command>
```

For native or GPU packages, also build the production image and run the
repository's import/linkage smoke test so a resolver-green but ABI-incompatible
update cannot land.

Run the repository's dependency or security audit command when it defines one,
for example `bun run security:audit`, and report its result. Do not substitute a
generic command for repository policy when no such audit is configured.

Verify generated artifacts when a dependency affects them. If applying multiple
batches, commit each only after its validation passes so rollback remains clear.

Report the full inventory, current and target versions, risk classification,
official migration evidence, concrete adoption opportunities, supply-chain
assessment, applied batches, checks run, and deferred or blocked work.
