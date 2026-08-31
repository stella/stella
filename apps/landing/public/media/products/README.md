# Product screenshots

These are deterministic captures of the real Stella application, not hand-built
marketing mockups. The capture suite uses the development seed so the UI, copy,
and available product states stay tied to production code.

## Refreshing the PNG screenshots

The `.png` baselines come from CI, never from a developer machine. PR CI runs
the `marketing-screenshots` check whenever a change can reach a captured
surface, so a UI change fails the PR that makes it instead of the next nightly
run. When the diff is intended, dispatch **Update marketing screenshots**
(`.github/workflows/marketing-screenshots-update.yml`) from the default
branch, naming the PR's branch:

```sh
gh workflow run marketing-screenshots-update.yml -f branch=<pr-branch>
```

Dispatching on `main` is what keeps the release App key on workflow code from
`main`: only the app and spec code checked out from `branch` is
branch-controlled, and the token never leaves the push step.

The capture body is the composite action `.github/actions/marketing-capture`
resolved from the branch, so a branch created before that action existed
must be rebased onto `main` first.

It regenerates every baseline on the CI runner and pushes them to the branch,
which re-runs the PR's checks against the new head. Because baselines and
comparison render on the same runner image, the pixel tolerance only has to
cover run-to-run noise.

Every update run also uploads the PNGs as a `marketing-screenshots-<run id>`
artifact. Only branches of this repository can be regenerated in place, so for
a fork PR run the update against a same-repository branch carrying the change
and commit the artifact's PNGs to the PR.

Running `bun --filter @stll/web test:e2e:marketing:update` locally is for
debugging a capture; do not commit macOS-generated PNGs.

## Recording the MP4 clips

The videos are recorded locally, then stored as immutable, content-addressed
objects outside Git. `bun --filter @stll/landing dev` and `build` hydrate the
exact manifest-pinned files into this directory before Astro starts; the local
copies are ignored and shared through Git's common worktree cache.

Start the stack, seed the authenticated test user and development data, then
record:

```sh
bun run dev --no-browser
bun --filter @stll/api db:seed-test-user
bun --filter @stll/api db:seed-dev
bun --filter @stll/web capture:product-story
```

In a git worktree the dev runner assigns offset ports (it prints them on
start, e.g. `web: http://localhost:3223`, `api: http://127.0.0.1:3224`); pass
them with `E2E_WEB_URL` and `E2E_API_URL`. Always use `localhost` for
`E2E_API_URL` even though the runner prints `127.0.0.1`: the session cookie is
scoped to the API host, and a `127.0.0.1` cookie never reaches the
`localhost` web origin, which strands the recorder on the sign-in screen.

```sh
cd apps/web && E2E_WEB_URL=http://localhost:3223 E2E_API_URL=http://localhost:3224 bun run capture:product-story
```

The capture suite selects the deterministic `Harbrook & Partners` organization
(`apps/api/scripts/seed-test-user.ts`), resolves seeded
workspace view IDs from the API, waits for real route content, and writes
light and dark files for every product in this directory.

After recording, regenerate the object manifest and publish it with an
authenticated AWS session that can write to the downloads CDN:

```sh
bun run marketing:media:manifest
PRODUCT_MEDIA_S3_BUCKET="$(gh variable get DOWNLOADS_BUCKET)" bun run marketing:media:publish
```

Publication verifies every local file against the manifest and creates only
content-addressed objects. Existing objects must have the same size and SHA-256
checksum. Commit `recordings-manifest.json` and
`apps/landing/product-media-manifest.json`; do not force-add the ignored MP4 or
poster files.

`capture:product-story` records the six Stella-owned scenes used in the
homepage story and product pages: Files, Table review, Editor, Agent, the
template studio (Templates), and the Knowledge tools catalogue (the CLI & MCP
chapter's own scene). It records both themes,
then converts Playwright's raw video to compact, streaming-friendly H.264 MP4.
The Microsoft Teams and terminal companion windows remain DOM components so
their typewriter, focus, and drag interactions stay crisp and interactive.

Each cut is anchored to a ready marker burned into the raw footage: once a
scene's prepare step fully settles, the recorder flashes a solid magenta
overlay, and the final cut always starts just after the marker leaves the
frame (located by per-frame chroma scan, never by wall-clock guesses). After
encoding, the recorder asserts per output that the duration matches the
scene's cut length, that the first frame matches a ready-state reference
screenshot (PSNR floor), and that the poster is pixel-identical to that first
frame (posters are frame 0 of the cut, so the poster-to-video handoff is
seamless). Any violation, including raw footage too short for the cut, fails
the recording run instead of shipping a partial or pre-ready clip. Loops are
kept short (~3.5s, agent 5.5s) and the choreography returns each scene to its
frame-0 state so the loop closes without a jump.

Pointer-choreographed scenes (workspace, review, agent, cli) show a fake cursor:
headless screencasts contain no OS cursor, so the recorder injects a
macOS-style arrow overlay (natural CSS-pixel size, scaled by the DPR-2
compositor) that follows the real mouse events, with a small expanding ring
on mousedown. All pointer movement runs through an eased interpolation helper
(~60 steps/s around `page.mouse.move`) so the cursor never teleports on
camera. Each cursor scene has a deliberate resting position; the prepare step
parks the cursor there before the ready marker fires, so the ready reference,
frame 0, and poster all include the cursor at rest, and the loop choreography
returns to that same spot (agent excepted, per its documented non-closing
loop). The editor and templates scenes keep the overlay off: their loop is a
document scroll with no pointer interaction, and a frozen cursor would
suggest interactions that are not happening.

## Scene variants

Each scene is recorded at the aspect of the box it plays in, so the landing
page never has to crop. All captures record at 2x device pixels
(`CAPTURE_DPR`); the viewports below are logical CSS sizes and the files on
disk are double that, so retina screens play native-resolution video. The
matrix lives in `apps/web/e2e/marketing/captures.ts`; capture ids are
`<scene>` (wide), `<scene>-hero`, and `editor-portrait`:

| Variant                                                                         | Viewport (file = 2x) | Consumed by                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| wide (`workspace`, `review`, `editor`, `agent`, `cli`, `templates`)             | 1280x720 (16:9)      | `productStoryMedia`: scene-only embeds (product pages via `ProductMediaFrame`, HomeProductStory chapters, nav thumbnails); `templates` is wide-only and plays on the templates product page                                                                                                            |
| hero (`workspace-hero`, `review-hero`, `editor-hero`, `agent-hero`, `cli-hero`) | 1280x764 (~1.674:1)  | `productStoryHeroMedia`: the companion composition's main window (homepage hero, sections with `showCompanions`)                                                                                                                                                                                       |
| portrait (`editor-portrait`)                                                    | 900x1036 (~0.869:1)  | `productStoryEditorPortraitMedia`: the floating "stella Editor" side window. Films the `editor-doc` scene: the seeded Supplier Agreement in the document full view with the app sidebar collapsed and the inspector closed, so the Word page fills the frame rather than the whole app squeezed narrow |

The registry is `apps/landing/src/data/product-story.ts`;
`RecordedStellaScene` picks the variant, and reduced-motion posters come from
the same media objects, so a re-recorded variant updates both automatically.

Re-record a subset with the comma-separated `MARKETING_CAPTURE` filter and an
optional `MARKETING_THEME` (`light` or `dark`):

```sh
bun run marketing:media:sync
cd apps/web && MARKETING_CAPTURE=editor-hero,editor-portrait MARKETING_THEME=dark bun run capture:product-story
```

## Verifying a recording session

Check that the outputs have the exact expected dimensions, then run the
content check and the landing build:

```sh
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 apps/landing/public/media/products/story-workspace-hero.mp4
sips -g pixelWidth -g pixelHeight apps/landing/public/media/products/story-workspace-hero-poster.jpg
bun run marketing:check
cd apps/landing && bun run build
```

## Keeping them current

The PR check runs the screenshot suite without `--update-snapshots`, so a
product UI change produces a reviewable screenshot diff instead of silently
leaving the landing page stale; update the paired MP4 clips in the same review.
The nightly run repeats the check against the default branch, covering drift a
per-file allowlist cannot see (dependency upgrades, seed changes). The marketing
content check verifies that every light/dark clip and poster referenced by the
shared scene registry is pinned in the product-media manifest. Route and content
guards prevent sign-in, loading, and organization-selection screens from being
accepted as product screenshots.

The recorder additionally stamps every capture into
`recordings-manifest.json` (in this directory): capture id, theme, viewport,
the commit it was recorded at, and the app surfaces it films. At release time,

```sh
bun run marketing:stale          # report per-capture FRESH/STALE verdicts
bun run marketing:stale --strict # same, but exit non-zero when anything is stale
```

diffs each capture's watched paths against its recorded-at commit (committed
history only) and prints the exact re-record command for anything stale, so
"the recordings silently drifted from the product" is a check failure, not a
memory. Record from a committed tree so the stamped commit matches the code
that produced the frames; when recording from a dirty tree, pass
`MARKETING_COMMIT=<sha>` to stamp the commit the changes will land in. Watched
paths cover the feature slices each scene films plus the recorder and seed;
rendering changes that arrive through dependency upgrades (notably
`@stll/folio-react` for the editor scene) are not tracked, so judge those
manually when bumping.

## Reshooting on release

`bun run marketing:reshoot` re-records only the captures `marketing:stale`
finds stale — never the whole matrix, so a reshoot never pays to re-record
scenes that already match the product:

```sh
bun run marketing:reshoot          # re-record whatever is stale
bun run marketing:reshoot --dry-run # print the stale set and the commands, do nothing
```

If everything is already fresh, it prints `all N recordings fresh — nothing
to reshoot` and exits without touching the app. Otherwise it preflights the
local stack (`E2E_WEB_URL` / `E2E_API_URL`, defaulting to the URLs above), and
if either is unreachable it prints the same "Refreshing the images" commands
from this file and exits without recording anything — it never starts
servers itself. Once the stack answers, it hydrates the manifest-pinned media,
re-records only the stale capture ids in one `capture:product-story` invocation
(both themes), then re-checks staleness and reports what turned fresh.

The script does not publish or commit. Land the result in the two commits this
directory's history already uses: first regenerate and publish the immutable
objects, then commit both manifests. In a separate `chore(landing): stamp
recording manifest against the committed tree` commit, rewrite
`recordedAtCommit` to the commit that just landed the manifests (the recorder
stamps the pre-commit HEAD, so it is one commit behind once the first commit
lands). The reshoot script prints the publish and commit commands, including a
ready-to-run `jq` snippet for the second commit.

`tag-on-version-bump.yml` runs `bun run marketing:stale --strict` before
pushing a release tag, so a stale recording fails the tag push instead of
shipping a landing page that has quietly drifted from the product. Clear it
with `bun run marketing:reshoot` before bumping `VERSION`.

`bun run release:maintenance` does not stop on stale recordings. It carries
them forward under a standing attestation, `Patch release, UX diff
negligible`, printing which captures it covered. A patch release therefore
ships whatever footage is already committed: reshoot before cutting one if
the product has visibly moved, and pass `--confirm-current-recordings-reviewed
--reason "<review reason>"` to record a specific review instead of the
default.

### Manual verification escape hatch

When existing media has been visually reviewed against the current app and
does not need new footage, commit an explicit manual verification instead of
rewriting `recordedAtCommit`:

```sh
bun run marketing:verify-current -- \
  --confirm-current-recordings-reviewed \
  --reason "Existing recordings visually reviewed for this release"
```

Use `--capture workspace,review` to limit the attestation. The command updates
only selected stale manifest entries and binds the review to a hash of their
exact watched source tree and manifest-pinned MP4/poster pair. Any later
relevant code or media change invalidates it. A new recording replaces the
entry and clears its manual verification.
