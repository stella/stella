---
"@stll/ui": patch
---

Render `OutlineRail` rows in the regular foreground rather than a muted grey, and let an entry ask for `secondary` emphasis so a caller that ranks its entries can step the near-misses back. Keep a controlled active row scrolled into view while the panel is open, and forward a wheel the panel cannot consume to the document behind it, so an outline with nothing to scroll no longer swallows the gesture. Mirror the disclosure chevron under RTL while it is collapsed, and mark the active row with `aria-current`.
