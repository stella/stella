# Captured parser fixtures

Every file here is a **capture**: the bytes a real source served, held
verbatim. Nothing in this directory is authored, trimmed, re-indented or
tidied.

## Why verbatim

A parser is only tested by the markup production actually receives. When
a fixture is prettified, the pretty-printer's own newlines and
indentation become part of the input, and they can stand in for
whitespace the parser has wrongly dropped. The suite then passes on text
the parser gets right only because the fixture was formatted.

That is not hypothetical. The cz-nss parser dropped Aspose's
whitespace-only spacer spans, merging `Ž a l o b a` and `s e` into one
run and re-cutting the words one letter off (`Žalob as ez amítá`). The
committed fixtures hid it: their pretty-printed newlines supplied the
missing gap.

## The rule

Each captured file sits beside a `<name>.provenance.json` sidecar:

```json
{
  "capture": "recorded",
  "sha256": "…",
  "sourceUrl": "https://…",
  "capturedAt": "2026-09-01T10:24:11.000Z"
}
```

`apps/api/src/tests/fixture-provenance.test.ts` recomputes every hash on
every run. Editing a fixture — by hand, with a formatter, or by an
editor that trims trailing whitespace on save — fails the suite and asks
for a recapture. `.editorconfig` disables both mutating rules for this
directory so an ordinary save cannot do it silently.

## Adding a fixture

New captures are made by script, never by hand:

```sh
bun apps/api/scripts/capture-parser-fixture.ts <url> --name cz-nss-8-as-12-2026.html
```

The eu-ecj corpus is the exception: its fixtures are gzipped and paired
with the Formex manifestation the parse is checked against, which only
the adapter's own query path resolves. Re-record it with
`bun apps/api/scripts/record-eu-ecj-fixtures.ts`, which writes the same
sidecars. `eu-ecj/corpus.ts` is source, not a fixture; it declares the
pairing that the recorder and the test both read.

## Legacy captures

Fixtures committed before this convention carry
`"capture": "legacy"` and a note instead of an origin. Their source URL
was never recorded and is not guessable, and inventing a plausible one
would read as verified provenance forever after. The hash still pins the
bytes; only the origin is unknown.

`LEGACY_CAPTURES` in `apps/api/src/tests/fixture-provenance.ts` lists
them, and the test holds that list and the sidecars to exact agreement.
The list is a ratchet: recapturing a fixture removes its entry, and
adding a new fixture without provenance means adding an entry, in the
diff, where review can see it.

## Not covered here

The template-literal HTML inside `cz-ns.test.ts`, `cz-nss.test.ts`,
`cz-us.test.ts`, `pl-courts.test.ts` and friends is deliberately out of
scope. Those are constructed inputs, authored to isolate one behavior;
editing them is the point. This convention governs files that claim to
represent a real document.