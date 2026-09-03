# Releases

Stella releases are portable application artifacts. The public repository
publishes what any deploy system needs to run Stella, without tying releases to
Stella-specific deploy details.

## Public Release Contract

<!-- BEGIN GENERATED RELEASE ARTIFACT CONTRACT -->

Each release publishes two container artifacts:

- The API image is portable and is the image used by the self-host
  Compose contract.
- The Web image is built for the release workflow's selected hosted
  target environment; self-hosted operators must build the web image with
  their own public URLs.
- `release-manifest.json` records both `image` and `webImage` with
  digest-qualified references.

<!-- END GENERATED RELEASE ARTIFACT CONTRACT -->

Each release tag (`vX.Y.Z` or `vX.Y.Z-rc.N`) also publishes:

- image references by release tag, git SHA, and immutable digest,
- GitHub release notes generated from merged changes, optionally prefixed with
  a manual description from `docs/changelog/<tag>.md`,
- a public changelog entry on `https://stll.app/changelog`, sourced from GitHub
  Releases.

The manifest is intentionally infra neutral. It names artifacts and migrations
only; environment-specific deploy details belong in the operator's private
infrastructure repository.

## Migration Policy

Production deploys should use explicit migration files from
`apps/api/drizzle/`. Do not use `drizzle-kit push` against production.

Schema changes should follow an expand/contract sequence:

1. Add backward-compatible schema first.
2. Deploy app code that can read/write both old and new shapes.
3. Backfill data in a separate, observable job when needed.
4. Remove obsolete schema only after every supported running version no longer
   depends on it.

Application rollback must not require database rollback. Destructive migrations
should lag the release that stopped using the old data.

## Creating A Release

1. Ensure CI is green on `main`.
2. Generate and review any required migration files.
3. Run `bun run marketing:stale`; if anything is stale, `bun run
marketing:reshoot` re-records only the stale captures (see
   `apps/landing/public/media/products/README.md`, "Reshooting on release").
4. In one commit, bump `VERSION` and optionally add the matching manual
   changelog note:

   ```bash
   printf "X.Y.Z\n" > VERSION
   $EDITOR docs/changelog/vX.Y.Z.md
   git add VERSION docs/changelog/vX.Y.Z.md
   git commit -m "chore: release vX.Y.Z"
   ```

   For RCs, use matching values such as `VERSION=1.2.3-rc.1` and
   `docs/changelog/v1.2.3-rc.1.md`.

5. Merge the commit to `main`. The `tag-on-version-bump.yml` workflow pushes
   the matching `vX.Y.Z` tag automatically. The tag then triggers
   `release.yml`.
6. Wait for the release workflow. It builds and attests the immutable
   images, creates the GitHub release as a draft with the manifest attached,
   and promotes stable releases automatically; the release is published and
   the `latest` image aliases advance only after `https://api.stll.app/ready`
   and the web origin report the exact release commit. A failed promotion
   leaves the tag, the immutable images, and the draft; rerunning the
   workflow for the same tag reuses them. RCs continue to target staging and
   are published as prereleases once the staging promotion finishes.
7. After a stable release succeeds, `publish-npm.yml` checks out the same
   release commit, packs the CLI, installs that exact tarball under plain Node,
   and runs its unauthenticated compatibility canary against production. Only
   then can the hardened npm publishing job publish `@stll/cli`.

Changing `packages/cli/package.json` on `main` does not publish the CLI by
itself. This ordering is deliberate: the API must advertise support for the
packed CLI's generated protocol contract, capabilities, and resource scopes
before the client becomes public. A manual CLI publish is recovery-only and
requires `release_ref` to name the stable release currently served by
production.

## API and CLI Compatibility

MCP protected-resource discovery publishes `stella_contract`, containing a
wire-protocol number, an additive server revision, and versioned capabilities.
The CLI bakes its supported protocols, minimum server revision, and required
capabilities into a generated snapshot. Package versions are deliberately not
part of that contract. `scopes_supported` remains the authoritative OAuth
resource-scope list.

Evolve the contract with these rules:

- Increment the revision only for additive server behavior. An older CLI must
  continue to work against every newer revision of its protocol.
- Increment a capability version only when the newer implementation still
  satisfies the older capability contract. Use a new capability name for a
  breaking feature change.
- Increment the protocol only for a breaking wire change. A CLI may list more
  than one supported protocol during a migration.

Before expanding the CLI contract:

1. Add the API behavior and scopes, then update the API revision or capability.
2. Regenerate and commit the CLI contract snapshot.
3. Ship that API in a stable release.
4. Let the post-release exact-tarball canary publish the CLI.

The legacy `stella_compatibility` package-version range remains frozen for
clients published before protocol negotiation. New CLIs prefer
`stella_contract`, so routine package bumps need no corresponding API edit.
Update notices resolve npm's `latest` release directly; the API owns only its
independent minimum-supported-version policy.

The CLI intersects ordinary login requests with the authorization server's
advertised scopes, so an older server remains usable for capabilities it
actually supports. Explicitly requested scopes remain requirements and fail
before browser authorization when unavailable.

CI enforces the cross-boundary invariants as one contract: the API must satisfy
the CLI's generated protocol, revision, and capability requirements, and every
packaged CLI scope must exist in the API's OAuth and MCP scope sets. The
canaried tarball's SHA-256 checksum is verified again in the isolated OIDC
publishing job, so npm receives those exact bytes.
