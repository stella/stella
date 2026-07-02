# Product hero videos

This directory holds the hero screen recordings for the product pages
(`/product/<slug>`). Drop a recording here and the page upgrades itself — no
data edits required.

## Path convention

Each product hero is:

- `/media/products/<slug>/hero.mp4` — the recording (required to upgrade)
- `/media/products/<slug>/hero.jpg` — an optional poster/first-frame image

Paths are relative to `apps/landing/public/`, so the file for `tabular-review`
lives at `apps/landing/public/media/products/tabular-review/hero.mp4`.

## How auto-detection works

`src/components/ProductMediaFrame.astro` checks the filesystem at build time:

- If `hero.mp4` exists, the hero renders as a looping, muted, autoplay
  `<video>` (`playsinline`).
- If `hero.jpg` also exists, it is used as the `poster`; otherwise no poster is
  emitted (never a broken link to a missing file).
- If `hero.mp4` does not exist yet, the hero shows the intentional skeleton
  placeholder, captioned with the product's `alt` text.

Because detection is by file presence, dropping the `.mp4` (and optionally the
`.jpg`) at the path above is the only step. There is nothing to wire up in the
product data files.

## What to record

| slug | product | screen / route to record | aspect | what the recording should show |
| --- | --- | --- | --- | --- |
| `public-data` | Official legal data, ready to pull into a matter | Case-law reader + a company-registry lookup, in a matter | 16 / 10 | Reading an official decision with structure intact, following a citation, then pulling a company registry record into a matter. |
| `anonymization` | Prepare material for AI without exposing identifying details | Anonymization inside chat / document review | 16 / 10 | Preparing a document for an AI step by keeping names, entities, and identifying details out. |
| `tabular-review` | Turn a pile of documents into a table you can review | Tabular Review grid in a matter | 16 / 10 | Turning a document set into a sortable, filterable table where each cell is cited back to the source text. |
| `agent` | An AI agent that works across your matters, files, and tools | AI agent chat thread | 16 / 10 | The agent answering across matters and files, asking for approval before acting, and grounding answers in citations. |
| `templates` | Build reusable templates, and let AI fill them in | Template editor + assembled draft | 16 / 10 | Filling a template's fields and watching conditional clauses resolve into a matter draft. |
| `workspace` | Matters, documents, and tools in one workspace | Matter view (documents / review / chat tabs) | 16 / 10 | Moving between a matter's documents, review, and chat in one workspace. |

## Encoding guidance

- Container/codecs: MP4 with H.264 video and either AAC audio or no audio track.
- Muted and loop-friendly: the clip autoplays muted and loops, so make the start
  and end seamless (no jarring cut).
- Keep files lean: target a few MB per clip (roughly ~1080p, ~10-20s).
- Match the aspect ratio in the table above (all heroes are `16 / 10`) so the
  frame does not letterbox or crop.
- Optional `hero.jpg` poster: export a clean first frame at the same aspect ratio.
