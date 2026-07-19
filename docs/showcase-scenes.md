# Showcase Scenes

The landing page presents the product through a small set of "scenes":
draft, review, and research. This runbook records what those scenes are,
how to re-record them, and how to decide at release time whether any of
them has gone stale.

## Inventory

| Scene    | Asset today                                            | Depicts                                             |
| -------- | ------------------------------------------------------ | --------------------------------------------------- |
| draft    | animated geometric tile (inline SVG in `index.astro`)  | drafting a document with AI assistance              |
| review   | animated geometric tile (inline SVG in `index.astro`)  | reviewing tracked changes on a contract             |
| research | animated geometric tile (inline SVG in `index.astro`)  | legal research across the corpus                    |

Legacy assets: `apps/landing/public/showcase/{draft,review,research}.png`
are the static poster screenshots that preceded the geometric tiles. They
are currently referenced nowhere in the source but are still published at
`/showcase/*.png`, so external links may point at them. History: the
scenes were originally Remotion-rendered videos; #807 replaced them with
poster images and then with the current geometric tiles, deleting the
Remotion pipeline.

## Re-recording a scene (product screenshots)

Use this whenever a scene shows real product UI (the legacy posters, or
any future reintroduction of screenshots/video).

1. Start the stack: `bun run dev --no-browser`, and seed demo content
   (`bun --filter @stll/api db:seed-dev`). Never screenshot real tenant
   data; scenes must only ever contain seeded demo content.
2. Browser setup: 1440×900 viewport at 2x device pixel ratio, light
   theme, `en` locale, no devtools or extensions visible.
3. Stage each scene:
   - **draft** — a document open in the editor with a partially drafted
     contract and the composer visible.
   - **review** — a DOCX with visible tracked changes and the suggestion
     review bar engaged.
   - **research** — legal research view with a query and result list
     (case law + legislation hits).
4. Capture, then optimize (`oxipng -o 4` or equivalent; keep each file
   under ~400 KB) and overwrite the asset in
   `apps/landing/public/showcase/`.
5. Commit with `docs(landing): re-record <scene> showcase scene`.

The geometric tiles are code, not recordings: they only need work when
the product story changes (e.g., a scene's headline feature is renamed
or replaced). Edit them in `apps/landing/src/pages/index.astro` and keep
the surrounding copy in sync.

## Catching stale scenes at release time

A scene is **stale** when a user comparing it to the shipping product
would notice a mismatch. Check, per scene, whether the release changed:

- the visual chrome of the depicted screen (navigation, editor frame,
  theme tokens, typography);
- the depicted feature itself (renamed, redesigned, or removed);
- the copy next to the scene (claims a capability the release changed).

Release procedure (referenced from `docs/releases.md`): before the
version-bump PR, open each scene beside the current app screen and mark
it fresh or stale; re-record stale ones as above in the same release.
Most releases will conclude "nothing stale" in a couple of minutes; the
point is that the check happens every time.

Future automation (not built): a Playwright job that stages each scene
from fixtures at the pinned viewport, screenshots it, and pixel-diffs
against the committed asset, failing the release checklist when the
difference exceeds a threshold. If the posters return to the landing
page, build this before relying on manual eyeballing.
