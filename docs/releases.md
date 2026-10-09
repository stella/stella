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

## Staging Verification

`deploy-staging.yml` runs on `main` only. Its optional `sha` input pins the
commit to deploy; blank deploys the tip of `main`. A pinned commit must be a
full SHA that `main` contains (`git merge-base --is-ancestor`), so a release
candidate can be deployed and verified while `main` keeps moving. Any other
value fails the run before anything is built. The run builds, promotes and
smokes that one commit. It records a Deployment as `in_progress` after
promotion and marks it `success` only when the gating web
and API chat smokes pass. The `staging/verified` commit status records the same
result on the deployed SHA and links to the workflow run. A new promotion resets
that status to `pending`; a failed or incomplete gating smoke records `failure`.
The API model-turn smoke retains its separate report-only policy.

The repository variable `STAGING_STATE` declares environment prerequisites as
JSON. Missing keys (or an unset variable) mean on: every check gates. The allowed
keys are `corpus_index` (`on` or `off`) and `rollout` (`on` or
`knowledge-web-pending`). Unknown keys, invalid values, and malformed JSON fail
closed. Set it explicitly when a prerequisite is unavailable:

```sh
gh variable set STAGING_STATE --repo stella/stella --body '{"corpus_index":"off","rollout":"knowledge-web-pending"}'
```

Return all checks to gating with:

```sh
gh variable delete STAGING_STATE --repo stella/stella
```

Only the public-law hydration check becomes report-only when `corpus_index=off`;
only Public Knowledge API/web flag consistency becomes report-only when
`rollout=knowledge-web-pending`. Assertions still run, and failures retain their
Playwright traces and report. Every smoke run logs the dispositions and reasons
and writes them to the step summary. Other test failures and runner errors gate.
Visitor route checks are skipped with an explicit reason when the web side is
disabled during a declared pending rollout; undeclared mismatches still gate.
This declaration records prerequisites; it does not infer state from responses
or change deployed feature flags.

## Creating A Release

1. Ensure CI is green on `main`.
2. Generate and review any required migration files.
3. Run `bun run marketing:stale`; if anything is stale, `bun run
marketing:reshoot` re-records only the stale captures (see
   `apps/landing/public/media/products/README.md`, "Reshooting on release").
4. In one commit, bump `VERSION` and add the matching changelog note. A
   release other than a maintenance release (`bun run release:maintenance`)
   must embed a screenshot or video in it; see `docs/changelog/README.md`:

   ```bash
   printf "X.Y.Z\n" > VERSION
   $EDITOR docs/changelog/vX.Y.Z.md
   git add VERSION docs/changelog/vX.Y.Z.md
   git commit -m "chore: release vX.Y.Z"
   ```

   For RCs, use matching values such as `VERSION=1.2.3-rc.1` and
   `docs/changelog/v1.2.3-rc.1.md`.

   A pull request that changes `VERSION` (or any migration) also runs the
   `migration-upgrade-rehearsal` CI job: it applies the schema of the release
   production currently serves from that release's published image, fills the
   registered high-volume tables with scale-shaped rows, then runs this
   commit's migrate entrypoint under a budget, reruns it, and checks schema
   parity. Its summary reports the base release and the timings.
   `scripts/rehearse-migration-upgrade.sh` runs the same rehearsal locally
   against an empty database.

   The same pull request runs `scripts/check-cli-release-coupling.ts`: a
   stable release is refused while a pending changeset names `@stll/cli`,
   because the CLI that has to ship with the release does not have a version
   yet. `bun run release:maintenance` applies every pending changeset in the
   release commit, so a release prepared with it leaves none pending. A
   hand-cut release needs `bun run changeset:version` in the same commit, plus
   `bun run changeset --empty`: the generated bumps are release-gated paths,
   and the changeset policy asks for an added entry beside them. The check
   also refuses a commit whose CLI version is behind npm's
   `latest`, or equals it while the generated contract surface differs from
   the published tarball.

5. Merge the commit to `main` and note its SHA. `main` stays open: later
   merges do not affect this release.
6. Deploy that exact commit to staging:

   ```bash
   gh workflow run deploy-staging.yml --ref main -f sha=<release-sha> -F release_candidate=true
   gh workflow run main-heavy.yml --ref main -f sha=<release-sha> -F release_candidate=true
   ```

   Both gates first refuse a candidate whose VERSION is already tagged or differs
   from the pending VERSION on main. Ordinary pinned dispatches leave
   `release_candidate` false and skip this check. The release-candidate heavy run dispatches
   `main-pr-depth.yml` for the same SHA. The staging run also refuses a
   SHA that `main` does not contain. When its smokes pass,
   the commit carries `staging/verified` = `success`. `main-heavy.yml`
   records `main/heavy`, while `main-pr-depth.yml` records `main/pr-depth`, on the same commit. If the run is cancelled because
   a newer staging dispatch replaced it while it waited, dispatch it again
   with the same `sha`; tagging refuses until `staging/verified` is green.

7. Tag the commit once all three statuses are green:

   ```bash
   gh workflow run release-tag.yml --ref main -f sha=<release-sha>
   ```

   `release-tag.yml` tags exactly that commit, and refuses unless both
   `staging/verified` and `main/heavy` are `success` on it; the refusal names
   each status that is missing or not green. It checks both again right
   before pushing the tag. Leaving `sha` blank selects the
   newest commit on `main` that carries both. The workflow also runs the CLI
   coupling check; if it fails (a CLI changeset merged after the release
   commit), apply it with `bun run changeset:version` plus
   `bun run changeset --empty` and release from the commit that merges it.
   The tag then triggers `release.yml`.

8. Wait for the release workflow. It builds and attests the immutable
   images, creates the GitHub release as a draft with the manifest attached,
   and promotes stable releases automatically; the release is published and
   the `latest` image aliases advance only after `https://api.stll.app/ready`
   and the web origin report the exact release commit. A failed promotion
   leaves the tag, the immutable images, and the draft; rerunning the
   workflow for the same tag reuses them. RCs continue to target staging and
   are published as prereleases once the staging promotion finishes.
9. After a stable release succeeds, `publish-npm.yml` checks out the same
   release commit, packs the CLI, installs that exact tarball under plain Node,
   and runs its unauthenticated compatibility canary against production. Only
   then can the hardened npm publishing job publish `@stll/cli`.

Changing `packages/cli/package.json` on `main` does not publish the CLI by
itself. This ordering is deliberate: the API must advertise support for the
packed CLI's generated protocol contract, capabilities, and resource scopes
before the client becomes public. A manual CLI publish is recovery-only and
requires `release_ref` to name the stable release currently served by
production.

## Package Versions

Package versions come from `.changeset/*.md`, and two flows apply them:

- `bun run release:maintenance` applies every pending entry in the release
  commit. The release therefore carries the package versions, package
  changelogs and deleted entries the version pull request would have produced,
  summarized under "Packages" in `docs/changelog/vX.Y.Z.md`, plus an empty
  changeset for the generated bumps themselves. Nothing stays pending, so the
  CLI coupling gate has nothing to refuse.
- `.github/workflows/release-pr.yml` maintains a Version Packages pull request
  for package releases between application releases. It stands down while a
  ready pull request into `main` is open whose title starts with
  `chore: release v` and whose head branch lives in this repository, since that
  release applies the same entries; `workflow_dispatch` runs it anyway.

Both run the repository's `changeset:version` script, so neither can produce a
different bump than the other.

Maintenance package bullets contain the first prose paragraph and link each
package to its full `CHANGELOG.md` at the application release tag. Tables,
lists, code blocks and later paragraphs remain in the package changelog.
Changeset frontmatter remains authoritative for package bumps and attribution;
release preparation does not infer package relevance from accumulated changes.

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
3. Let the release commit apply the changeset, or merge the Version Packages
   pull request, so the CLI carries its new version.
4. Ship that API in a stable release.
5. Let the post-release exact-tarball canary publish the CLI.

A stable release therefore has one of two shapes, and the coupling check
refuses every other:

- Unchanged: the commit's CLI version is npm's `latest` and its generated
  contract surface equals the published tarball. The published CLI keeps
  working; the release may only add server behavior.
- Coupled: the commit's CLI version is newer than anything published. The
  server change may drop behavior the previous CLI relied on, and
  `publish-npm.yml` publishes the new CLI as soon as production serves the
  release. Between promotion and publication the previous CLI can fail
  against production; that window is minutes and is the whole cost of a
  non-additive change, so keep such changes rare and batch them into one
  coupled release.

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
