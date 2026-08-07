# Stella Landing Site

The public marketing site for Stella, built with Astro.

## Development

```bash
bun --filter @stll/landing dev
```

## Commands

```bash
bun --filter @stll/landing build
bun --filter @stll/landing preview
bun --filter @stll/landing typecheck
```

## Social cards

Every page's Open Graph card is generated during `build` from that page's own
`<title>`, by the `og-cards` integration (`src/integrations/og-cards.ts`). Pages
need no card asset and no card text: give the page a title and it gets a
matching preview. Cards land in `dist/images/og/` and are not committed.

They therefore do not exist under `dev`; use `preview` to check one.

Two cards are drawn differently, both through the same renderer
(`src/lib/og-card.ts`):

- Changelog releases set the heading large and the version as a badge, served
  from `src/pages/images/changelog/[release].png.ts`.
- The committed site-wide card (`public/images/og-card.png`) is the fallback for
  pages whose title neither card face can draw. Regenerate it with
  `bun run render:og-card` after a layout change.

### Card faces

A card is set in exactly one face, chosen by the page's writing direction:
Cabinet Grotesk for `ltr`, IBM Plex Sans Arabic for `rtl` (which mirrors the
layout too, wordmark included). Arabic gets a different family from the app's
UI because resvg resolves one font per text element and draws `.notdef` for
whatever that font lacks, so an Arabic title carrying a Latin product name
("تحرير مستندات Word") must come from a single face covering both scripts.

Each face is coverage-checked against its own titles before a card path is
handed out; a locale in a script neither face covers falls back to the static
card rather than shipping boxes, and `og-card-path.test.ts` fails if that ever
starts happening.
