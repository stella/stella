# Corpus fixtures — provenance & licensing

Every `.docx` file in this directory was **synthesised for this test suite** by
`packages/folio/scripts/build-corpus-fixtures.ts`. They are hand-written OOXML
packages wrapped in `JSZip`; no third-party templates were copied.

Because the content was authored from scratch as a documentation artefact for
testing the parser/serializer, the fixtures are released under the same
**Apache-2.0** license as the rest of the package (see the repository
`LICENSE` file).

To re-generate after editing the script:

```sh
cd packages/folio
bun run scripts/build-corpus-fixtures.ts
```

## Inventory

| File                        | What it exercises                                                      |
| --------------------------- | ---------------------------------------------------------------------- |
| `block-sdt-richtext.docx`   | Block-level `<w:sdt>` wrapping a paragraph; alias, tag, lock           |
| `inline-sdt-dropdown.docx`  | Inline `<w:sdt>` with `<w:dropDownList>` (three `w:listItem`s)         |
| `inline-sdt-checkbox.docx`  | Inline `<w:sdt>` with `<w14:checkbox>` in the checked state            |
| `inline-sdt-mixed-rpr.docx` | Nested inline SDTs whose content carries mixed `<w:rPr>` (bold/italic) |
| `alt-prefix-sdt.docx`       | All `w:` elements rebound to an `x:` prefix; date SDT                  |

## Out of scope here

`w15:repeatingSection` is not part of the current Document model surface and
is intentionally not exercised by these fixtures. Adding support for it is
tracked separately.
