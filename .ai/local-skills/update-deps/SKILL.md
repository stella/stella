---
name: update-deps
description: 'Review and update Stella dependencies across Bun, Cargo, Docker, and optionally GitHub Actions with scoped lockfile changes, official release evidence, and supply-chain checks.'
---

# Update Dependencies

Review or update third-party dependencies without widening the requested batch
or running ecosystem commands from the wrong workspace.

## Scope

Default to Bun packages, the desktop Cargo crate, and Docker base images.
Include GitHub Actions when the request names them or files under `.github/`
are affected. `$ARGUMENTS` may narrow packages, risk level, or whether the task
is advisory versus an actual bump.

For a vague full sweep, inventory everything first, divide it into coherent
batches, and use one validated commit per batch. Do not stop after finding the
first easy update.

## 1. Establish Sources of Truth

- Bun: root `package.json` catalogs/resolutions, workspace manifests, and
  `bun.lock`.
- Cargo: `apps/desktop/src-tauri/Cargo.toml` and its `Cargo.lock`.
- Docker: every tracked `Dockerfile*` plus Compose `image:` reference.
- Actions: `.github/dependabot.yml` and workflow SHA pins.

Respect `bunfig.toml` release-age controls and existing dependency-review,
SBOM, and provenance workflows. Do not duplicate healthy automation unless
the user asks for an audit.

## 2. Inventory the Complete Requested Scope

Run Bun inventory from the repository root:

```bash
bun outdated --filter="*"
```

Run Cargo commands against Stella's actual manifest, never the repository
root:

```bash
cargo outdated --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The default Cargo inventory includes transitive dependencies. If
`cargo-outdated` is unavailable, use:

```bash
cargo update --manifest-path apps/desktop/src-tauri/Cargo.toml --dry-run
```

Then inspect targeted roots with `cargo search` or `cargo info`. Prefer a
prebuilt `cargo-outdated` install when available rather than spending minutes
compiling it.

Inventory Docker references explicitly:

```bash
rg -n '^\s*(FROM|image:)\s+' \
  --glob 'Dockerfile*' --glob '*compose*.yml' --glob '*compose*.yaml' \
  --glob '!node_modules/**'
```

Record the current tag and digest. Resolve a candidate through its official
registry metadata, for example `docker buildx imagetools inspect <image>`, and
compare the resulting digest before editing. A floating tag is not proof that
the repository already consumes the current image.

Flag prerelease pins and non-`latest` channels separately. Compare their
intended channel with `npm view <pkg> dist-tags`; do not silently move a beta,
RC, next, or canary dependency to stable.

## 3. Classify and Research Before Editing

- Patch: usually lowest risk, still inspect behavior and provenance.
- Minor: check new features and silent behavior changes.
- Major or `0.x` minor: assume migration work.
- Prerelease: assume any bump can break behavior.

Use official release notes, migration guides, package metadata, registries,
and source repositories. Check peer dependencies, engines, runtime/module
format, native binaries, and deprecated APIs. Search current usage with `rg`
and identify concrete workarounds or shims the new release can remove.

For a fresh or suspicious release, inspect release age, publisher/repository
changes, tags, lifecycle scripts, native artifacts, and provenance. Escalate
to tarball or file-tree comparison only when metadata is unusual, the package
is high risk, or the user requested a supply-chain audit.

## 4. Apply One Coherent Batch

- Update the root catalog/resolution rather than creating workspace drift.
- `bun update --latest` may rewrite an exact prerelease pin or channel; use it
  only when that channel change is deliberate. Otherwise resolve the exact
  target, edit the source of truth, and run `bun install`.
- For Cargo versions already allowed by the manifest, update only planned root
  crates:

  ```bash
  cargo update --manifest-path apps/desktop/src-tauri/Cargo.toml -p <crate>
  ```

  Edit `Cargo.toml` only when moving beyond the declared range. Never run bare
  `cargo update` for an ordinary batch; it updates unrelated eligible lockfile
  entries. A full-graph update must be an explicit, separately reviewed batch.
- Keep Docker images pinned by digest and update the tag/digest pair together.
- Keep Actions pinned to commit SHAs.

Review every manifest and lockfile delta before staging. Unexpected transitive
additions, package replacements, lifecycle scripts, native blobs, or unrelated
Cargo lockfile movement require investigation or a narrower update.

## 5. Validate in Layers

Start with affected-package checks, then run repository checks proportionate
to the batch. Cargo validation always points at the real manifest:

```bash
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

For Bun changes, run focused tests while iterating and `bun run verify` before
publication when the task and machine allow it. Build changed Docker targets
and verify their resolved digests. Regenerate any dependency-owned artifacts.

Commit each passing batch before starting the next. Prefer removing obsolete
helpers, polyfills, or duplicate packages over passive dependency growth.

## Report

Report the complete batch plan, current and target versions/digests, risk and
release evidence, adoption opportunities, suspicious-release assessment,
lockfile scope, validation, commits, and deferred or blocked majors.
