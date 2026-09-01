/**
 * Provenance for captured parser fixtures.
 *
 * A captured fixture is a file holding the bytes a real source served:
 * a court's XML, a publisher's XHTML, the gzip of either. It earns its
 * place in the suite by being what production actually receives, so the
 * moment anything rewrites it — a formatter, an editor honoring
 * `.editorconfig`, a hand edit trimming "noise" — it stops answering
 * that question while still looking like it does.
 *
 * That failure is silent and it has already cost us once: pretty-printed
 * fixture newlines supplied whitespace the parser had dropped, so the
 * suite passed on markup production never sees.
 *
 * Every captured fixture therefore sits beside a `<name>.provenance.json`
 * sidecar naming the sha256 of its bytes. `fixture-provenance.test.ts`
 * walks the roots below and recomputes every hash, so an edit fails the
 * suite and names recapture as the fix.
 *
 * Synthetic inline fixtures — the template-literal HTML in cz-ns,
 * cz-nss, cz-us, pl-courts and friends — are deliberately out of scope.
 * They are constructed inputs, authored to isolate one behavior, and
 * editing them is the point.
 */

import path from "node:path";

/** Sidecar naming: `at-ris-jjt-1925.xml` → `at-ris-jjt-1925.xml.provenance.json`. */
export const PROVENANCE_SUFFIX = ".provenance.json";

/**
 * Fixture roots holding captured documents, relative to `apps/api`.
 *
 * Adding a root is how a fixture directory opts into the hash guard.
 */
export const CAPTURED_FIXTURE_ROOTS = [
  "src/handlers/case-law/ingestion/adapters/__fixtures__",
  "src/handlers/case-law/ingestion/parsers/__fixtures__",
] as const;

/**
 * A capture whose origin is known, because a script recorded it.
 *
 * `sourceUrl` and `capturedAt` are required: a recorder always knows
 * both, and a capture that cannot name where it came from is not a
 * recorded capture.
 */
export type RecordedProvenance = {
  capture: "recorded";
  sha256: string;
  sourceUrl: string;
  capturedAt: string;
  note?: string;
};

/**
 * A capture that predates this convention.
 *
 * Deliberately carries no `sourceUrl`/`capturedAt`: the origin was never
 * written down, and inventing a plausible URL would be worse than
 * admitting the gap — a fabricated source reads as verified provenance
 * forever after. The hash still pins the bytes, so the file cannot drift
 * unnoticed; only its origin is unknown.
 */
export type LegacyProvenance = {
  capture: "legacy";
  sha256: string;
  note: string;
};

export type FixtureProvenance = RecordedProvenance | LegacyProvenance;

export const LEGACY_NOTE =
  "legacy capture, provenance unknown; recapture on next touch";

/**
 * Every captured fixture still lacking a recorded origin.
 *
 * A ratchet, not an inventory: `fixture-provenance.test.ts` holds this
 * list and the `capture: "legacy"` sidecars to exact agreement in both
 * directions, so the set can shrink as fixtures are recaptured but a new
 * legacy capture cannot be added without editing this list in the diff.
 * New fixtures come from `scripts/capture-parser-fixture.ts` and are
 * `recorded`.
 */
export const LEGACY_CAPTURES = [
  "src/handlers/case-law/ingestion/adapters/__fixtures__/at-courts-page.json.gz",
  "src/handlers/case-law/ingestion/adapters/__fixtures__/cz-ns-page.json.gz",
  "src/handlers/case-law/ingestion/adapters/__fixtures__/cz-us-page.json.gz",
  "src/handlers/case-law/ingestion/adapters/__fixtures__/eu-ecj-fulltext-cs.html",
  "src/handlers/case-law/ingestion/adapters/__fixtures__/eu-ecj-fulltext-en.html",
  "src/handlers/case-law/ingestion/adapters/__fixtures__/eu-ecj-sparql.json",
  "src/handlers/case-law/ingestion/adapters/__fixtures__/pl-courts-page.json.gz",
  "src/handlers/case-law/ingestion/adapters/__fixtures__/sk-courts-page.json.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/at-findok-bfg-2026.xml",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/at-ris-jjt-1925.xml",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62013TO0488.cs.fmx.xml.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62013TO0488.cs.html.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62017CJ0258.pl.fmx.xml.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62017CJ0258.pl.html.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62018CC0311.fi.fmx.xml.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62018CC0311.fi.html.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62018CJ0311.en.fmx.xml.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62018CJ0311.en.html.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62018CJ0311.lv.fmx.xml.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62018CJ0311.lv.html.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62022CJ0128.el.fmx.xml.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62022CJ0128.el.html.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62022CJ0128.en.fmx.xml.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62022CJ0128.en.html.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62022CJ0128.en.page.html.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62023CO0786.en.fmx.xml.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62023CO0786.en.html.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62023TJ0201.en.fmx.xml.gz",
  "src/handlers/case-law/ingestion/parsers/__fixtures__/eu-ecj/62023TJ0201.en.html.gz",
] as const satisfies readonly string[];

/**
 * Files that live in a fixture root without being captures.
 *
 * `corpus.ts` declares the eu-ecj pairing shared by the recorder and the
 * test; `README.md` states the convention. Both are source, both are
 * meant to be edited and formatted.
 */
const NON_FIXTURE_EXTENSIONS = new Set([".ts", ".tsx", ".md"]);

/** Whether a path inside a fixture root is a captured document. */
export const isCapturedFixture = (relativePath: string): boolean => {
  const name = path.basename(relativePath);
  if (name.startsWith(".") || name.endsWith(PROVENANCE_SUFFIX)) {
    return false;
  }
  return !NON_FIXTURE_EXTENSIONS.has(path.extname(name));
};

export const provenancePathOf = (fixturePath: string): string =>
  `${fixturePath}${PROVENANCE_SUFFIX}`;

export const sha256Of = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/**
 * Serialize a sidecar.
 *
 * Two-space indent and a trailing newline is also oxfmt's own JSON
 * spelling, so the formatter and this generator agree and a freshly
 * captured sidecar never lands unformatted. Sidecars are ordinary
 * generated JSON — unlike the fixtures they describe, reformatting one
 * costs nothing, because the hash they carry is of the fixture's bytes.
 */
export const formatProvenance = (provenance: FixtureProvenance): string =>
  `${JSON.stringify(provenance, null, 2)}\n`;

/** Read a non-empty string field off an unknown payload. */
const stringField = (payload: unknown, key: string): string | undefined => {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(payload, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

// A sidecar is file content, so parsing it is a trust boundary: a
// malformed one is reported by path in the test rather than thrown here,
// where the message could name only the parser.
const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** Parse a sidecar, returning `undefined` for anything malformed. */
export const parseProvenance = (raw: string): FixtureProvenance | undefined => {
  const payload = parseJson(raw);
  const sha256 = stringField(payload, "sha256");
  if (sha256 === undefined) {
    return undefined;
  }
  const note = stringField(payload, "note");
  const capture = stringField(payload, "capture");

  if (capture === "legacy") {
    return note === undefined ? undefined : { capture: "legacy", sha256, note };
  }
  if (capture !== "recorded") {
    return undefined;
  }

  const sourceUrl = stringField(payload, "sourceUrl");
  const capturedAt = stringField(payload, "capturedAt");
  if (sourceUrl === undefined || capturedAt === undefined) {
    return undefined;
  }
  return {
    capture: "recorded",
    sha256,
    sourceUrl,
    capturedAt,
    ...(note === undefined ? {} : { note }),
  };
};
