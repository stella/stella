# Product screenshots

These are deterministic captures of the real Stella application, not hand-built
marketing mockups. The capture suite uses the development seed so the UI, copy,
and available product states stay tied to production code.

## Refreshing the images

Start the local stack, seed the authenticated test user and development data,
then update the snapshots:

```sh
bun run dev --no-browser
bun --filter @stll/api db:seed-test-user
bun --filter @stll/api db:seed-dev
bun --filter @stll/web test:e2e:marketing:update
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

The capture suite selects the deterministic `Test Firm`, resolves seeded
workspace view IDs from the API, waits for real route content, and writes
light and dark files for every product in this directory.

`capture:product-story` records the four Stella-owned scenes used in the
homepage story: Files, Table review, Editor, and Agent. It records both themes,
then converts Playwright's raw video to compact, streaming-friendly H.264 MP4.
The Microsoft Teams and terminal companion windows remain DOM components so
their typewriter, focus, and drag interactions stay crisp and interactive.

## Scene variants

Each scene is recorded at the aspect of the box it plays in, so the landing
page never has to crop. The matrix lives in
`apps/web/e2e/marketing/captures.ts`; capture ids are `<scene>` (wide),
`<scene>-hero`, and `editor-portrait`:

| Variant | Viewport | Consumed by |
| --- | --- | --- |
| wide (`workspace`, `review`, `editor`, `agent`) | 1280x720 (16:9) | `productStoryMedia`: scene-only embeds (product pages via `ProductMediaFrame`, HomeProductStory chapters, nav thumbnails) |
| hero (`workspace-hero`, `review-hero`, `editor-hero`, `agent-hero`) | 1280x764 (~1.674:1) | `productStoryHeroMedia`: the companion composition's main window (homepage hero, sections with `showCompanions`); the `cli` scene reuses `agent-hero` |
| portrait (`editor-portrait`) | 900x1036 (~0.869:1) | `productStoryEditorPortraitMedia`: the floating "stella Editor" side window |

The registry is `apps/landing/src/data/product-story.ts`;
`RecordedStellaScene` picks the variant, and reduced-motion posters come from
the same media objects, so a re-recorded variant updates both automatically.

Re-record a subset with the comma-separated `MARKETING_CAPTURE` filter and an
optional `MARKETING_THEME` (`light` or `dark`):

```sh
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

CI runs the screenshot suite without `--update-snapshots`. Product UI changes
therefore produce a reviewable screenshot diff instead of silently leaving the
landing page stale; update the paired MP4 clips in the same review. The marketing
content check verifies that every light/dark clip and poster referenced by the
shared scene registry exists. A small pixel tolerance covers operating-system
font rendering; route and content guards prevent sign-in, loading, and
organization-selection screens from being accepted as product screenshots.

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
