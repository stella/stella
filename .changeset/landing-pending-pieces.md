---
"@stll/ui": minor
---

`@stll/ui/landing-shell` holds the landing's layout and sections without the row text, so a pending view can import it cheaply; `@stll/ui/landing` re-exports it. It adds pending pieces on the landing's own geometry: `LandingRowsPending` (placeholder rows on a `LandingItemText` row's lines, optionally announced as a busy region), `LandingSectionHeadingPending` and `LandingBoxPending` (the hero box, built from the composer tokens).
