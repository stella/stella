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

A maintenance release runs in this order:

1. Cut: `bun run release:maintenance` on a clean checkout of `main`. Before it
   writes anything it runs every release-tag gate it can decide on that tree
   (`main/heavy` and `main/pr-depth` on the commit, the dependency audit, the
   npm publish lag) and refuses with one verdict naming each failure. It also
   lists the gates only the tag decides on the version commit: release
   evidence, the changelog and CLI coupling. `--allow-unproven-main` passes
   over `main/heavy` and `main/pr-depth` only; a dependency audit waiver is
   `WAIVE_DEPENDENCY_AUDIT=true WAIVER_REASON='<reason>'`, as for the tag.
2. Release PR: commit the prepared files, open the pull request and merge it
   through the queue once its CI is green.
3. Release-candidate staging deploy (step 6 below). If staging is off, the run
   starts it with a 2 h lease and waits until it answers before deploying.
4. Tag (step 7 below).

The steps in full:

1. Ensure CI is green on `main`.
2. Generate and review any required migration files.
3. Run `bun run marketing:stale`; if anything is stale,
   `bun run marketing:reshoot` re-records only the stale captures (see
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

5. Merge the commit to `main` and note its SHA. This version commit is the
   only commit that can ship under that version. The push dispatches
   `release-tag.yml` and staging with its exact SHA; missing gates fail the tag run.
   When the merged tree matches the release pull request head and that head
   already passed staging, the staging proof is reused instead of deploying
   the identical tree again. Otherwise staging deploys and verifies the version
   commit.
   `main` stays open: later merges do not affect this release.
6. The release-candidate gates start at the cut by themselves: when the release
   pull request opens or updates, `release-proof.yml` dispatches
   `deploy-staging.yml` and `main-heavy.yml` once for its head with
   `release_candidate=true`. To run them again by hand:

   ```bash
   gh workflow run main-heavy.yml --ref main -f sha=<release-pr-head-sha> -F release_candidate=true
   ```

   Both gates first refuse a candidate whose VERSION is already tagged. A
   candidate that is not yet on `main` must be a release pull request head the
   trusted release-tree verifier accepts; a candidate on `main` must be the
   commit that set the pending VERSION. Ordinary pinned dispatches leave
   `release_candidate` false and skip this check. The release-candidate heavy run dispatches
   `main-pr-depth.yml` for the same SHA. The version
   commit's staging run is started automatically after merge, reusing the
   candidate's proof when their trees match. Outside a release-candidate run, staging refuses a SHA that `main` does not contain. When staging does not answer, the
   release-candidate run starts it through the infra repository's
   `staging-power.yml` (`action=on`, `hours=2`; the lease powers it off
   again), waits up to 15 minutes for that run and up to 45 minutes for
   `/ready`, and otherwise refuses with the `staging/verified` error and the
   reason. Other dispatches still refuse an off staging. When its smokes pass,
   the commit carries `staging/verified` = `success`. `main-heavy.yml`
   records `main/heavy`, while `main-pr-depth.yml` records `main/pr-depth`, on the same commit. If the run is cancelled because
   a newer staging dispatch replaced it while it waited, dispatch it again
   with the same `sha`; tagging refuses until `staging/verified` is green.

   A commit that landed through the merge queue usually needs neither heavy
   status. The queue fast-forwards `main` to the merge-group commit, so the
   `ci-result` check of that merge group's CI run sits on the release commit
   itself. That check is the merge-group receipt: a `ci-result` check run on
   the release commit, created by GitHub Actions, concluded `success`, in a
   `merge_group` run of `.github/workflows/ci.yml` from `main`'s queue that
   also completed successfully. It stands in for both `main/heavy` and
   `main/pr-depth`. If any merge-group `ci-result` on the commit is not a
   success, or a `ci-result` check run cannot be tied to its workflow run, the
   receipt is refused and the two statuses are required. `staging/verified` is
   required either way.

   A merge-group run validates only its own group's diff, so the receipt also
   needs every commit since the previous release tag to have reached `main`
   through a validated merge group. The gate runs
   `bun scripts/check-release-queue-history.ts --require` over that range; an
   admin merge, a direct push, or history that cannot be read keeps
   `main/heavy` and `main/pr-depth` required, and the log names the commits
   the receipt does not cover.

7. Tag the commit once `staging/verified` is green and it carries either the
   merge-group receipt or green `main/heavy` and `main/pr-depth`:

   ```bash
   gh workflow run release-tag.yml --ref main -f sha=<release-sha>
   ```

   `release-tag.yml` tags exactly that commit, and refuses unless
   `staging/verified` is `success` on it and it carries the merge-group
   receipt or `success` on both `main/heavy` and `main/pr-depth`; the refusal
   names each gate that is missing or not green. It checks them again right
   before pushing the tag. Leaving `sha` blank selects the version commit;
   an explicit SHA must name that same commit. Tree-identical release PR
   evidence may satisfy the existing proof checks, but later main commits
   cannot replace the version commit. The workflow also runs the CLI coupling
   check against that commit. The other independent gates continue when one
   fails, and one final verdict lists each gate that failed or did not run. If
   dependency installation fails, the dependency-audit gate remains unrun.
   `-F dry_run=true` evaluates all gates and reports them without pushing the
   tag. The tag then triggers `release.yml`.

8. Wait for the release workflow. It builds and attests the immutable
   images, creates the GitHub release as a draft with the manifest attached,
   and promotes stable releases automatically; the release is published and
   the `latest` image aliases advance only after `https://api.stll.app/ready`
   and the web origin report the exact release commit. A failed promotion
   leaves the tag, the immutable images, and the draft; rerunning the
   workflow for the same tag reuses them. RCs continue to target staging and
   are published as prereleases once the staging promotion finishes.
9. Once production serves a stable release, `release.yml` dispatches
   `release-health.yml`. It waits until 60 minutes after publication, then
   compares the release's failure fingerprints (handler, error class and
   code, counted by the API as `release_failure_window` analytics events)
   with the previous stable release's. Any `unclassified` failure, or a
   fingerprint the previous release never produced that occurs at least
   three times, makes the release unhealthy; a query that cannot answer
   makes it inconclusive. The run records the verdict as
   `release-health.json` on the GitHub release and fails unless the verdict
   is healthy, which alerts through `scheduled-run-alerts.yml`. The query
   reads the `POSTHOG_RELEASE_HEALTH_API_KEY` secret (a PostHog personal API
   key limited to query read) and the `POSTHOG_PROJECT_ID` variable.

   The next production promotion refuses while the previous stable release
   is unhealthy, inconclusive, or still inside its window without a
   verdict. After investigating, re-dispatch `release.yml` for the new tag
   with `acknowledge_unhealthy_release` set to that previous release.

10. After a stable release succeeds, `publish-npm.yml` checks out the same
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
