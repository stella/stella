# Releases

Stella releases are portable application artifacts. The public repository
publishes what any deploy system needs to run Stella, without tying releases to
Stella-specific deploy details.

## Public Release Contract

<!-- BEGIN GENERATED RELEASE ARTIFACT CONTRACT -->

Each release candidate builds three container artifacts once:

- The API image is portable and is the image used by the self-host
  Compose contract.
- The staging Web image and production Web image use their respective
  hosted public URLs; self-hosted operators must build the web image with
  their own public URLs.
- `release-manifest.json` records `image`, `webImage` and
  `productionWebImage` with digest-qualified references.
- The final release aliases these proven digests without rebuilding images.

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

### Migration completion and deployment failure

Run the release's migration entrypoint to completion before replacing serving
application instances. A migration error exits nonzero and stops promotion;
the existing application version keeps serving. Deferred online work keeps
migration running: it logs `migrate.online_deferred`, waits, and retries until
settled. A deferral does not authorize an application rollout.

Schema lock contention gets bounded retries. Exhausted attempts, a spent retry
budget, or changed migration receipts stop migration with an error. Earlier
committed steps may remain applied; a rerun reads the migration ledger again.
Inspect migration task logs and the failed promotion workflow before rerunning.
The deployment result retains the migration exit status and task diagnostics.

`migrate.lock_attempt` records each observed work step's terminal outcome and
lock waits, including requested mode, table, wait duration, and blocker activity
with query fingerprints. Attempt counts include bounded statement retries. Fingerprints strip literals and quoted identifiers before
truncation. Existing `migrate.phase_duration` and
`migrate.online_step_duration` records include `retriesSpent`; these fields use
the existing log pipeline and require no additional metrics. Lock inspection is
sampled, so waits shorter than the inspection interval may not be observed.

## Staging Verification

`deploy-staging.yml` executes its trusted workflow from `main`. A normal
pinned `sha` must be a full SHA contained by `main`. Release proofs instead
supply `release_candidate=true`, `release_ref=vX.Y.Z-rc.N` and the exact release
pull request head. The candidate verifier checks that commit against its merge
base on `main` (`git merge-base <rc-sha> origin/main`), so later unrelated
merges do not invalidate it. The complete base-to-RC range includes the version
bump and every release correction. With `release_ref`, staging
uses the RC manifest's API and staging web digests and skips its build jobs.

When staging is off, an RC proof starts it through `staging-power.yml` with a
2 h lease and waits for readiness before promotion. Other staging dispatches
still refuse an off environment. After promotion the deployment is
`in_progress`; gating web and API chat smokes must pass before it becomes
`success`. `staging/verified` records the result on the exact deployed SHA and
links to its workflow run. Promotion resets the status to `pending`; failed or
incomplete smokes record `failure`. Before each write, the workflow rechecks the
newest run and status owner, so a superseded proof cannot overwrite its
replacement's status. The API model-turn smoke remains report-only.

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

A release is proved on the release branch before production changes. Its RC and
final tags point at the same commit; the final release promotes the images built
by the RC run.

1. Start with a clean checkout of `main`, green CI, and reviewed migrations.
   Run `bun run marketing:stale`; `bun run marketing:reshoot` re-records stale
   captures (see `apps/landing/public/media/products/README.md`).
2. Run `bun run release:maintenance`. It derives the next patch version from
   the newest final `vX.Y.Z` tag, applies pending changesets, writes `VERSION`
   and `docs/changelog/vX.Y.Z.md`, creates one release commit on
   `release/vX.Y.Z`, and opens `chore: release vX.Y.Z` into `main`. An earlier
   open release pull request blocks another cut. The command runs the existing
   pre-cut heavy, dependency-audit and npm-publish-lag gates before writing.
   `--allow-unproven-main` permits missing heavy evidence at the cut only;
   dependency waivers require `WAIVE_DEPENDENCY_AUDIT=true` and
   `WAIVER_REASON='<reason>'`. There is no `--refresh` path.
3. Opening or updating that pull request starts `release-proof.yml`, which
   dispatches `release-tag.yml` with `mode=rc` and the exact head SHA. The tag
   workflow verifies the candidate against its merge base with `main` and runs the release
   gates, including changelog and CLI coupling. It refuses an existing final
   tag. Otherwise it allocates `vX.Y.Z-rc.N`, where `N` is one greater than the
   highest existing RC number. A tag already on this SHA is reused. `VERSION`
   stays `X.Y.Z`; the RC suffix belongs to the tag.
4. `release.yml` accepts the RC only while its commit is the open release pull
   request's head. It builds and smokes the multi-architecture API image with
   `STELLA_VERSION=X.Y.Z`, builds both hosted web images and the extension ZIP,
   and creates a draft prerelease with the immutable manifest. It boots the
   exact production web image, fetches its index and three hashed assets, and
   checks that its configuration differs from staging only in declared
   environment keys.
5. The RC run dispatches staging with `release_ref` and its exact SHA. Staging
   promotes the manifest digests without building, then runs its existing
   smokes. The RC run also dispatches `main-heavy.yml` and `main-pr-depth.yml`
   for that SHA. Finalization requires trusted green `staging/verified`,
   `main/heavy` and `main/pr-depth` evidence on the exact RC commit. A later
   `main` commit or tree-equivalent commit cannot replace it.
6. Completion of those proof workflows invokes `release-tag.yml`'s `finalize`
   job. It rechecks release health, finds the RC tag on the proved SHA, pushes
   `vX.Y.Z` on that same SHA and publishes the RC prerelease. An existing final
   tag is a no-op. Finalization performs no dependency install or approval wait.
   A red proof produces no final tag or production promotion; pushing a fix to
   the release branch creates the next RC number and proves it again.
7. The final tag starts `release.yml` in alias mode. Build, image smoke and web
   build jobs do not run. It assigns the final image tags to the RC digests,
   creates the final manifest and draft release, and promotes production. The
   promote dispatch reuses a successful or active promotion for this release,
   or production already serving its SHA, before considering another dispatch.
   Production migrations run inside the infra promotion; rollout waits for
   them to finish. Both API `/ready` and web `version.json` must report the
   release SHA.
8. After production verification, separate idempotent jobs publish the GitHub
   release with `--latest=false`, advance image `:latest` aliases to the proved
   digests, and start release health if that ref has no health run. Rerunning a
   partially failed final run checks those receipts and completes missing work.
   `release-complete` reports missing synchronous receipts: production,
   published release, image `:latest` aliases and health-run dispatch. It does
   not wait for the separate npm or desktop workflows, or the health window.
9. `publish-npm.yml` and `release-desktop.yml` accept a successful
   `promote-production` job for that exact ref even if another job made the
   overall release run red. RC runs publish no npm versions or dist-tags.
   Stable npm publication checks out the exact RC-proved release SHA, builds
   and packs the CLI using the unchanged version-codegen and trusted-publishing
   workflow, then runs the plain-Node smoke and production compatibility canary
   on that tarball. Package versions remain Changesets-owned. Desktop skips
   installers and `latest.json` already attached to the release; GitHub Latest
   advances only after the desktop assets are ready.
10. Squash-merge the release pull request through the ordinary queue once its
    checks pass. Its release-branch commit is not an ancestor of `main`; the
    squash merge does not retag, rebuild or refresh the release branch. Autofix
    leaves `release/v*` heads untouched, and their branch rules prohibit force
    pushes and deletion.

Final-run retries also accept the same release pull request after its squash
merge, provided its recorded head still equals the RC SHA. New RC tags require
an open release pull request. Changelog corrections can be pushed as later
commits to produce the next RC; executable fixes land on main first and reach
the release branch by merging main into it. Every candidate verifies the full
range from that merge base.

A pull request that changes `VERSION` or migrations also runs
`migration-upgrade-rehearsal`: it starts with the schema of the release
production currently serves, fills registered high-volume tables with
scale-shaped rows, runs this commit's migration entrypoint under a budget,
reruns it, and checks schema parity. Its summary records the base release and
timings. `scripts/rehearse-migration-upgrade.sh` runs the rehearsal locally
against an empty database.

The CLI coupling gate refuses a pending changeset naming `@stll/cli`, a CLI
version behind npm's `latest`, or a version equal to `latest` whose generated
contract differs from the published tarball. Maintenance preparation consumes
all pending changesets in its release commit. A hand-prepared release needs
`bun run changeset:version` in the same commit and an empty changeset beside the
generated bumps. Non-maintenance releases also require a screenshot or video in
the changelog note; see `docs/changelog/README.md`.

After stable publication, `release-health.yml` waits until 60 minutes after
publication, then compares production-only `release_failure_window` events with
the previous stable release. Staging RC events never count. An `unclassified`
failure, or a new handler/error-class/code fingerprint occurring at least three
times, makes the release unhealthy; an unavailable query makes it inconclusive.
The workflow uploads `release-health.json` and alerts on a non-healthy verdict.
It uses `POSTHOG_RELEASE_HEALTH_API_KEY` for query read and
`POSTHOG_PROJECT_ID` to identify the project.

The next production promotion refuses while the previous release is unhealthy,
inconclusive or still inside its window without a verdict. After investigating,
re-dispatch `release.yml` with `acknowledge_unhealthy_release` naming that previous
release. Changing `packages/cli/package.json` on `main` does not publish the CLI;
manual publication is recovery-only and requires the stable release currently
served by production.

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
