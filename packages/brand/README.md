# @stll/brand

The brand palette: typed hex values and the sRGB triples derived from them.

## What lives here

- `BRAND_COLORS`: the brand palette's hex values. DESIGN.md's "Brand Colours"
  table is rendered from `BRAND_PALETTE` by `scripts/design-tokens-doc.ts`.
- `NEUTRAL_COLORS`: the paper and ink that output with no theme draws with
  (generated PDFs, canvas pages, QR codes).
- `BRAND_SRGB`, `NEUTRAL_SRGB` and `srgbFromHex`: the same colours as sRGB
  channels in 0..1, computed from the hex values, for PDF operators.

Interface colour is not here: it comes from the theme tokens in
`packages/ui/src/styles/theme.css`. The `no-raw-color-literals` lint rule and
the stylelint colour rules allow a raw colour only in this package, the theme
stylesheets, and the exemptions `oxlint.config.ts` lists with their reasons.

## What does not

Theme tokens, app-specific wiring, and colour that is document data (user file
content, file-format defaults).

## License

Apache-2.0
