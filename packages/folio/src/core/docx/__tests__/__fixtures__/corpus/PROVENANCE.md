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

| File                            | What it exercises                                                        |
| ------------------------------- | ------------------------------------------------------------------------ |
| `block-sdt-richtext.docx`       | Block-level `<w:sdt>` wrapping a paragraph; alias, tag, lock             |
| `inline-sdt-dropdown.docx`      | Inline `<w:sdt>` with `<w:dropDownList>` (three `w:listItem`s)           |
| `inline-sdt-checkbox.docx`      | Inline `<w:sdt>` with `<w14:checkbox>` in the checked state              |
| `inline-sdt-mixed-rpr.docx`     | Nested inline SDTs whose content carries mixed `<w:rPr>` (bold/italic)   |
| `alt-prefix-sdt.docx`           | All `w:` elements rebound to an `x:` prefix; date SDT                    |
| `nested-block-sdt.docx`         | Outer block SDT wrapping an inner block SDT wrapping a paragraph         |
| `sdt-rpr-placeholder.docx`      | `<w:sdtPr>` containing a `<w:rPr>` (color + bold) and an alias/tag       |
| `empty-sdt-content.docx`        | Inline SDT with an empty `<w:sdtContent/>`; tests round-trip idempotence |
| `authored-empty-paragraph.docx` | Block SDT whose content is an authored `<w:p/>` empty paragraph          |
| `date-fractional-seconds.docx`  | `w:fullDate="2026-06-02T00:00:00.000Z"` with millisecond precision       |
| `dropdown-empty-value.docx`     | Dropdown whose first `w:listItem` has `w:value=""`                       |
| `lock-sdt-locked.docx`          | `<w:lock w:val="sdtLocked"/>`                                            |
| `lock-content-locked.docx`      | `<w:lock w:val="contentLocked"/>`                                        |
| `lock-sdt-content-locked.docx`  | `<w:lock w:val="sdtContentLocked"/>`                                     |
| `repeating-section.docx`        | `<w15:repeatingSection/>` marker inside `<w:sdtPr>`                      |
| `checkbox-val-true.docx`        | `<w14:checked w14:val="true"/>` (boolean form of ST_OnOff)               |
| `checkbox-val-false.docx`       | `<w14:checked w14:val="false"/>` (boolean form of ST_OnOff)              |
| `placeholder-docpart.docx`      | `<w:placeholder><w:docPart w:val="DefaultText"/></w:placeholder>`        |
| `datahash-sdt.docx`             | `<w16sdtdh:dataHash w16sdtdh:val="..."/>` marker inside `<w:sdtPr>`      |

All fixtures are under 30 KB.

## Modelled-coverage skips

A few of the proposed edge cases would have required model surfaces that
folio's `SdtProperties` does not currently project. The fixtures are still
included so the upgrade path lands on green; the assertions are reduced to
what the model can express today, and the gap is recorded here.

- **BlockSdt property preservation** — block `<w:sdt>` wrappers (the
  `block-sdt-richtext.docx`, `nested-block-sdt.docx`, `repeating-section.docx`
  and `authored-empty-paragraph.docx` fixtures) are unwrapped on parse, so the
  outer alias/tag/lock are not assertable. Tests cover content fidelity only.
- **`rawPropertiesXml` for unknown sdtPr children** — there is no escape hatch
  on `SdtProperties` to carry through unknown markers verbatim, so the
  `sdt-rpr-placeholder.docx`, `repeating-section.docx`, and `datahash-sdt.docx`
  fixtures assert "sdtType is not mis-classified" and "alias/tag round-trip"
  instead of asserting the raw marker survives.
- **Dropdown last selected value (`w:val` on `w:sdtPr` / sdt content
  binding)** — `SdtProperties` exposes `listItems` but not a separate
  "currently selected" field, so the duplicate-displayText scenario from the
  task brief was not added as a dedicated fixture; it would have nothing to
  assert beyond what `inline-sdt-dropdown.docx` already covers.
- **`dateValueISO`** — folio stores the raw `w:fullDate` ISO string in
  `dateFormat`. The `date-fractional-seconds.docx` fixture asserts the raw
  string survives there rather than on a dedicated field.

## Out of scope here

`w15:repeatingSection` is covered as a regression-only fixture; modelling it
as its own `sdtType` is tracked separately.
