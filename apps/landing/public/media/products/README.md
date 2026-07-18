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

Worktree ports can be passed with `E2E_WEB_URL` and `E2E_API_URL`. The capture
suite selects the deterministic `Test Firm`, resolves seeded workspace view IDs
from the API, waits for real route content, and writes light and dark PNG files
for every product in this directory.

`capture:product-story` records the four Stella-owned scenes used in the
homepage story: Files, Table review, Editor, and Agent. It records both themes,
then converts Playwright's raw video to compact, streaming-friendly H.264 MP4.
The Microsoft Teams and terminal companion windows remain DOM components so
their typewriter, focus, and drag interactions stay crisp and interactive.

## Keeping them current

CI runs the screenshot suite without `--update-snapshots`. Product UI changes
therefore produce a reviewable screenshot diff instead of silently leaving the
landing page stale; update the paired MP4 clips in the same review. The marketing
content check verifies that every light/dark clip and poster referenced by the
shared scene registry exists. A small pixel tolerance covers operating-system
font rendering; route and content guards prevent sign-in, loading, and
organization-selection screens from being accepted as product screenshots.
