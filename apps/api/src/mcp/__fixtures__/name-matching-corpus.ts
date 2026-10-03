import type { GazetteerEntry } from "@stll/anonymize";

/**
 * Labeled corpus for deny-list name matching on the anonymized request path.
 *
 * Every name, firm and identifier below is synthetic. Each case carries the
 * full text sent through the pipeline and one `surface`: the span the label
 * talks about. A `redact` case passes when every identifying word of the
 * surface is gone from the output; a `keep` case passes when the surface is
 * still present verbatim. Each surface occurs exactly once in its text, which
 * the corpus test asserts.
 */

export const NAME_MATCHING_REDACT_CLASSES = [
  "exact",
  "case",
  "diacritics-dropped",
  "diacritics-added",
  "typo-1",
  "typo-2",
  "inflected",
  "inflected-diacritics-dropped",
  "legal-form-variant",
  "split",
  "common-word-person",
  "exact-low-signal",
  "surname-first",
  "template-glued",
  "uncased-script",
  "multi-label",
] as const;

export const NAME_MATCHING_KEEP_CLASSES = [
  "hex",
  "uuid",
  "hash",
  "id-code",
  "marker",
  "ordinary-word",
  "adjacent-word",
  "template-field",
  "reordered-organization",
  "uncased-script-near-miss",
] as const;

export const FORCED_VALUE_REDACT_CLASSES = [
  "forced-exact",
  "forced-case",
  "forced-embedded",
] as const;

export const FORCED_VALUE_KEEP_CLASSES = [
  "forced-near-miss",
  "forced-other-id",
  "forced-adjacent-word",
] as const;

export type NameMatchingRedactClass =
  | (typeof NAME_MATCHING_REDACT_CLASSES)[number]
  | (typeof FORCED_VALUE_REDACT_CLASSES)[number];
export type NameMatchingKeepClass =
  | (typeof NAME_MATCHING_KEEP_CLASSES)[number]
  | (typeof FORCED_VALUE_KEEP_CLASSES)[number];

export type NameMatchingCase =
  | {
      expectation: "redact";
      kind: NameMatchingRedactClass;
      text: string;
      surface: string;
    }
  | {
      expectation: "keep";
      kind: NameMatchingKeepClass;
      text: string;
      surface: string;
    };

const entry = (
  index: number,
  canonical: string,
  label: "organization" | "person",
): GazetteerEntry => ({
  id: `corpus-entry-${String(index)}`,
  canonical,
  label,
  variants: [],
  workspaceId: "corpus-workspace",
  createdAt: 0,
  source: "manual",
});

/**
 * Deny-list entries: short and long, firms with legal forms, CZ/SK/EN people,
 * and names in scripts without letter case.
 */
export const NAME_MATCHING_ENTRIES: readonly GazetteerEntry[] = [
  entry(1, "Acme A", "organization"),
  entry(2, "Zeta", "organization"),
  entry(3, "Orbis", "organization"),
  entry(4, "Beta Trading s.r.o.", "organization"),
  entry(5, "Horská stavební a.s.", "organization"),
  entry(6, "Lipová Invest spol. s r.o.", "organization"),
  entry(7, "Northfield Analytics Ltd", "organization"),
  entry(8, "Tatranská energetika, a. s.", "organization"),
  entry(9, "Marie Dvořáková", "person"),
  entry(10, "Tomáš Kubíček", "person"),
  entry(11, "Ľubomír Šťastný", "person"),
  entry(12, "Zuzana Kováčová", "person"),
  entry(13, "Harriet Wellbourne", "person"),
  entry(14, "Novák", "person"),
  // Single-word person names that are also ordinary words.
  entry(15, "Mark", "person"),
  entry(16, "Will", "person"),
  entry(17, "Grant", "person"),
  entry(18, "Malý", "person"),
  entry(19, "Oxa", "organization"),
  // One spelling under two labels, listed organization first.
  entry(20, "Lindgarth", "organization"),
  entry(21, "Lindgarth", "person"),
  // Scripts without letter case: Georgian, Japanese, Thai.
  entry(22, "ნინო ბერიძე", "person"),
  entry(23, "紫苑工房", "organization"),
  entry(24, "กมลวรรณ ศรีสุข", "person"),
];

const redact = (
  kind: NameMatchingRedactClass,
  text: string,
  surface: string,
): NameMatchingCase => ({ expectation: "redact", kind, text, surface });

const keep = (
  kind: NameMatchingKeepClass,
  text: string,
  surface: string,
): NameMatchingCase => ({ expectation: "keep", kind, text, surface });

/** Cases evaluated with {@link NAME_MATCHING_ENTRIES} as the deny-list. */
export const NAME_MATCHING_CASES: readonly NameMatchingCase[] = [
  // exact
  redact(
    "exact",
    "Smlouvu podepsala společnost Beta Trading s.r.o. dne 3. 5.",
    "Beta Trading s.r.o.",
  ),
  redact("exact", "Za kupujícího jednala Marie Dvořáková.", "Marie Dvořáková"),
  redact("exact", "Návrh doručil partner Acme A včas.", "Acme A"),
  redact("exact", "Dodavatelem zůstává Zeta.", "Zeta"),
  redact("exact", "The report from Orbis arrived late.", "Orbis"),
  redact(
    "exact",
    "Signed for and on behalf of Northfield Analytics Ltd.",
    "Northfield Analytics Ltd",
  ),
  redact("exact", "Witnessed by Harriet Wellbourne.", "Harriet Wellbourne"),
  redact("exact", "Odvolanie podal Ľubomír Šťastný.", "Ľubomír Šťastný"),
  redact("exact", "Pan Novák s návrhem souhlasil.", "Novák"),
  redact(
    "exact",
    "Odberateľom je Tatranská energetika, a. s.",
    "Tatranská energetika, a. s.",
  ),
  redact(
    "exact",
    "Stavbu provedla Horská stavební a.s.",
    "Horská stavební a.s.",
  ),
  // case
  redact("case", "PRODÁVAJÍCÍ: BETA TRADING S.R.O.", "BETA TRADING S.R.O."),
  redact("case", "kontakt: marie dvořáková", "marie dvořáková"),
  redact("case", "PARTNER: ACME A", "ACME A"),
  redact("case", "dodavatel zeta potvrdil", "zeta"),
  redact("case", "CLIENT: ORBIS", "ORBIS"),
  redact("case", "cc: harriet wellbourne", "harriet wellbourne"),
  redact("case", "ŽALOBCE: NOVÁK", "NOVÁK"),
  // diacritics dropped
  redact(
    "diacritics-dropped",
    "Za kupujiciho Marie Dvorakova.",
    "Marie Dvorakova",
  ),
  redact(
    "diacritics-dropped",
    "Jednatel Tomas Kubicek podepsal.",
    "Tomas Kubicek",
  ),
  redact(
    "diacritics-dropped",
    "Odvolanie podal Lubomir Stastny.",
    "Lubomir Stastny",
  ),
  redact(
    "diacritics-dropped",
    "Splnomocnenkyna Zuzana Kovacova.",
    "Zuzana Kovacova",
  ),
  redact(
    "diacritics-dropped",
    "Stavbu provedla Horska stavebni a.s. vcas.",
    "Horska stavebni a.s.",
  ),
  redact(
    "diacritics-dropped",
    "Investorem je Lipova Invest spol. s r.o. od roku 2020.",
    "Lipova Invest spol. s r.o.",
  ),
  redact("diacritics-dropped", "Pan Novak s navrhem souhlasil.", "Novak"),
  redact(
    "diacritics-dropped",
    "Odberatelom je Tatranska energetika, a. s.",
    "Tatranska energetika, a. s.",
  ),
  // diacritics added
  redact("diacritics-added", "Klient Orbís zaplatil.", "Orbís"),
  redact("diacritics-added", "Dodavatelem je Zéta.", "Zéta"),
  redact(
    "diacritics-added",
    "Společnost Béta Trading s.r.o. odpověděla.",
    "Béta Trading s.r.o.",
  ),
  redact("diacritics-added", "Partner Acmé A potvrdil.", "Acmé A"),
  redact(
    "diacritics-added",
    "Signed by Hárriet Wellbourne.",
    "Hárriet Wellbourne",
  ),
  // typos, one edit
  redact("typo-1", "Witnessed by Harriet Welbourne.", "Harriet Welbourne"),
  redact(
    "typo-1",
    "Prodávající Beta Tradinq s.r.o. souhlasí.",
    "Beta Tradinq s.r.o.",
  ),
  redact(
    "typo-1",
    "Prepared by Northfield Analytic Ltd.",
    "Northfield Analytic Ltd",
  ),
  redact("typo-1", "Za kupujícího Marie Dvořákvá.", "Marie Dvořákvá"),
  redact("typo-1", "Jednatel Tomáš Kubíšek podepsal.", "Tomáš Kubíšek"),
  redact("typo-1", "Splnomocnenkyňa Zuzanna Kováčová.", "Zuzanna Kováčová"),
  redact("typo-1", "Klient Orbys zaplatil.", "Orbys"),
  // typos, two edits
  redact("typo-2", "Witnessed by Hariet Welbourne.", "Hariet Welbourne"),
  redact(
    "typo-2",
    "Prodávající Bta Tradng s.r.o. souhlasí.",
    "Bta Tradng s.r.o.",
  ),
  redact(
    "typo-2",
    "Prepared by Northfeld Analytcs Ltd.",
    "Northfeld Analytcs Ltd",
  ),
  redact("typo-2", "Za kupujícího Mare Dvořákvá.", "Mare Dvořákvá"),
  redact("typo-2", "Splnomocnenkyňa Zuzana Kováčovová.", "Zuzana Kováčovová"),
  redact(
    "typo-2",
    "Investorem je Lipová Invst spl. s r.o.",
    "Lipová Invst spl. s r.o.",
  ),
  // inflected
  redact("inflected", "Dopis byl zaslán panu Novákovi.", "Novákovi"),
  redact("inflected", "Žaloba proti panu Nováka byla podána.", "Nováka"),
  redact("inflected", "Jednal jsem s panem Novákem.", "Novákem"),
  redact("inflected", "Plnou moc udělila Marii Dvořákové.", "Marii Dvořákové"),
  redact("inflected", "Jednal jsem s Marií Dvořákovou.", "Marií Dvořákovou"),
  redact("inflected", "Podpis Tomáše Kubíčka chybí.", "Tomáše Kubíčka"),
  redact(
    "inflected",
    "Zaslali jsme to Tomášovi Kubíčkovi.",
    "Tomášovi Kubíčkovi",
  ),
  redact(
    "inflected",
    "Rozsudok proti Ľubomírovi Šťastnému.",
    "Ľubomírovi Šťastnému",
  ),
  redact(
    "inflected",
    "Návrh Zuzany Kováčovej bol zamietnutý.",
    "Zuzany Kováčovej",
  ),
  redact(
    "inflected",
    "Stretli sme sa so Zuzanou Kováčovou.",
    "Zuzanou Kováčovou",
  ),
  redact(
    "inflected",
    "Faktura od Horské stavební a.s. dorazila.",
    "Horské stavební a.s.",
  ),
  redact(
    "inflected",
    "Smlouva s Horskou stavební a.s. platí.",
    "Horskou stavební a.s.",
  ),
  redact(
    "inflected",
    "Zmluva s Tatranskou energetikou, a. s. platí.",
    "Tatranskou energetikou, a. s.",
  ),
  // inflected with diacritics dropped
  redact(
    "inflected-diacritics-dropped",
    "Dopis byl zaslan panu Novakovi.",
    "Novakovi",
  ),
  redact(
    "inflected-diacritics-dropped",
    "Jednal jsem s panem Novakem.",
    "Novakem",
  ),
  redact(
    "inflected-diacritics-dropped",
    "Plnou moc udelila Marii Dvorakove.",
    "Marii Dvorakove",
  ),
  redact(
    "inflected-diacritics-dropped",
    "Podpis Tomase Kubicka chybi.",
    "Tomase Kubicka",
  ),
  redact(
    "inflected-diacritics-dropped",
    "Rozsudok proti Lubomirovi Stastnemu.",
    "Lubomirovi Stastnemu",
  ),
  redact(
    "inflected-diacritics-dropped",
    "Navrh Zuzany Kovacovej bol zamietnuty.",
    "Zuzany Kovacovej",
  ),
  redact(
    "inflected-diacritics-dropped",
    "Faktura od Horske stavebni a.s. dorazila.",
    "Horske stavebni a.s.",
  ),
  // legal-form variants
  redact(
    "legal-form-variant",
    "Prodávající: Beta Trading, s.r.o.",
    "Beta Trading, s.r.o.",
  ),
  redact(
    "legal-form-variant",
    "Prodávající: Beta Trading s. r. o.",
    "Beta Trading s. r. o.",
  ),
  redact(
    "legal-form-variant",
    "Prodávající: Beta Trading, s. r. o.",
    "Beta Trading, s. r. o.",
  ),
  redact(
    "legal-form-variant",
    "Prodávající: Beta Trading spol. s r.o.",
    "Beta Trading spol. s r.o.",
  ),
  redact("legal-form-variant", "Prodávající je Beta Trading.", "Beta Trading"),
  redact(
    "legal-form-variant",
    "Zhotovitel: Horská stavební, a.s.",
    "Horská stavební, a.s.",
  ),
  redact(
    "legal-form-variant",
    "Zhotovitel: Horská stavební a. s.",
    "Horská stavební a. s.",
  ),
  redact(
    "legal-form-variant",
    "Investor: Lipová Invest s.r.o.",
    "Lipová Invest s.r.o.",
  ),
  redact(
    "legal-form-variant",
    "Investor: Lipová Invest, spol. s r. o.",
    "Lipová Invest, spol. s r. o.",
  ),
  redact(
    "legal-form-variant",
    "Odberateľ: Tatranská energetika a.s.",
    "Tatranská energetika a.s.",
  ),
  redact(
    "legal-form-variant",
    "Prepared by Northfield Analytics Limited.",
    "Northfield Analytics Limited",
  ),
  // split across whitespace or punctuation
  redact("split", "Za kupujícího Marie\nDvořáková.", "Marie\nDvořáková"),
  redact("split", "Za kupujícího Marie  Dvořáková.", "Marie  Dvořáková"),
  redact("split", "Za kupujícího Marie Dvořáková.", "Marie Dvořáková"),
  redact("split", "Za kupujícího Dvořáková, Marie.", "Dvořáková, Marie"),
  redact(
    "split",
    "Prodávající Beta\nTrading s.r.o. souhlasí.",
    "Beta\nTrading s.r.o.",
  ),
  redact(
    "split",
    "Prodávající Beta  Trading s.r.o. souhlasí.",
    "Beta  Trading s.r.o.",
  ),
  redact("split", "Witnessed by Harriet\tWellbourne.", "Harriet\tWellbourne"),
  redact("split", "Partner Acme A potvrdil.", "Acme A"),
  redact("split", "Jednatel Tomáš\r\nKubíček podepsal.", "Tomáš\r\nKubíček"),
  // single-word person names that are also ordinary words
  redact(
    "common-word-person",
    "Signed by Mark on behalf of the buyer.",
    "Mark",
  ),
  redact(
    "common-word-person",
    "The notice was sent to Will yesterday.",
    "Will",
  ),
  redact("common-word-person", "Approved by Grant on Monday.", "Grant"),
  redact("common-word-person", "Za kupujícího jednal pan Malý.", "Malý"),
  redact("common-word-person", "Jednali jsme s panem Malým.", "Malým"),
  // exact hits with little supporting signal: lowercase common words,
  // sentence starts, quotes, a three-letter entry; no score threshold applies
  redact("exact-low-signal", "please ask will, thanks.", "will"),
  redact("exact-low-signal", "hello mark there.", "mark"),
  redact("exact-low-signal", "grant signed the deal.", "grant"),
  redact("exact-low-signal", "„Grant“ souhlasí.", "Grant"),
  redact("exact-low-signal", "Za dodavatele jedná Oxa.", "Oxa"),
  redact("exact-low-signal", "dodavatel oxa potvrdil", "oxa"),
  // person names written surname first
  redact("surname-first", "Za kupujícího Dvořáková Marie.", "Dvořáková Marie"),
  redact("surname-first", "ŽALOVANÝ: KUBÍČEK Tomáš", "KUBÍČEK Tomáš"),
  redact(
    "surname-first",
    "Witnessed by Wellbourne, Harriet.",
    "Wellbourne, Harriet",
  ),
  redact(
    "surname-first",
    "Wellbourne Harriet signed the lease.",
    "Wellbourne Harriet",
  ),
  redact(
    "surname-first",
    "Odvolanie podal ŠŤASTNÝ Ľubomír.",
    "ŠŤASTNÝ Ľubomír",
  ),
  redact("surname-first", "Účastník: KOVÁČOVÁ, Zuzana", "KOVÁČOVÁ, Zuzana"),
  redact(
    "surname-first",
    "Jednal jsem s Dvořákovou Marií.",
    "Dvořákovou Marií",
  ),
  redact(
    "surname-first",
    "Plnou moc udělila Dvořákové Marii.",
    "Dvořákové Marii",
  ),
  redact(
    "surname-first",
    "Doručeno: Kubíčkovi Tomášovi.",
    "Kubíčkovi Tomášovi",
  ),
  // names glued to template brackets and markup punctuation
  redact("template-glued", "Šablona [[Zeta2024]] je hotová.", "Zeta2024"),
  redact("template-glued", "Šablona {{Zeta_01}} je hotová.", "Zeta_01"),
  redact("template-glued", "Šablona <<Orbis7>> je hotová.", "Orbis7"),
  redact("template-glued", "Šablona [[Orbis_v2]] je hotová.", "Orbis_v2"),
  redact("template-glued", "Šablona {{Novák_2024}} je hotová.", "Novák"),
  redact("template-glued", "Pole <<Acme A>> je vyplněno.", "Acme A"),
  redact(
    "template-glued",
    "Vložte {{Marie Dvořáková}} do hlavičky.",
    "Marie Dvořáková",
  ),
  redact(
    "template-glued",
    '{"name":"Tomáš Kubíček","role":"jednatel"}',
    "Tomáš Kubíček",
  ),
  redact(
    "template-glued",
    "შაბლონი {{ნინო ბერიძე}} შევსებულია.",
    "ნინო ბერიძე",
  ),
  redact(
    "template-glued",
    "შაბლონი [[ნინო ბერიძე2024]] შევსებულია.",
    "ნინო ბერიძე2024",
  ),
  redact(
    "template-glued",
    "შაბლონი {{ნინო ბერიძე_01}} შევსებულია.",
    "ნინო ბერიძე_01",
  ),
  // scripts without letter case
  redact("uncased-script", "მოსარჩელე: ნინო ბერიძე", "ნინო ბერიძე"),
  redact(
    "uncased-script",
    "ხელშეკრულებას ხელს აწერს ნინო ბერიძე, მყიდველი.",
    "ნინო ბერიძე",
  ),
  redact(
    "uncased-script",
    "ხელშეკრულება გააფორმა ნინო ბერიძემ.",
    "ნინო ბერიძემ",
  ),
  redact("uncased-script", "საქმე: ნინო ბერიძის სარჩელი", "ნინო ბერიძის"),
  redact("uncased-script", "ბერიძე ნინო, მოსარჩელე", "ბერიძე ნინო"),
  redact("uncased-script", "契約当事者：紫苑工房", "紫苑工房"),
  redact("uncased-script", "ผู้ซื้อ กมลวรรณ ศรีสุข ลงนามแล้ว", "กมลวรรณ ศรีสุข"),
  // one spelling listed under two labels
  redact("multi-label", "Smlouvu uzavřela společnost Lindgarth.", "Lindgarth"),
  redact("multi-label", "Lindgarth signed the lease.", "Lindgarth"),
  redact("multi-label", "Podle smlouvy Lindgarth dodá zboží.", "Lindgarth"),

  // hex runs
  keep(
    "hex",
    "commit 3f2acfeca1b04d2e9c7a5b6d8e0f1a2b merged",
    "3f2acfeca1b04d2e9c7a5b6d8e0f1a2b",
  ),
  keep("hex", "build acme0a1b2c3d4e5f ready", "acme0a1b2c3d4e5f"),
  keep("hex", "pointer 0xacbe12ef freed", "0xacbe12ef"),
  keep("hex", "blob deadbeefacfe0042 stored", "deadbeefacfe0042"),
  keep("hex", "seed ACFE00A1 used", "ACFE00A1"),
  // UUIDs
  keep(
    "uuid",
    "request 9b1d0c3e-acfe-4ca1-8b2e-5c7a0a1b2c3d failed",
    "9b1d0c3e-acfe-4ca1-8b2e-5c7a0a1b2c3d",
  ),
  keep(
    "uuid",
    "row acee4f1b-0c2d-4e5f-9a8b-7c6d5e4f3a2b updated",
    "acee4f1b-0c2d-4e5f-9a8b-7c6d5e4f3a2b",
  ),
  keep(
    "uuid",
    "file 0d8f6a2c-acde-4b7e-8f01-ac3ea1b2c3d4 uploaded",
    "0d8f6a2c-acde-4b7e-8f01-ac3ea1b2c3d4",
  ),
  keep(
    "uuid",
    "dokument 7e4b9c1a-2f3d-4a5b-b6c7-d8e9f0a1b2c3 nahrán",
    "7e4b9c1a-2f3d-4a5b-b6c7-d8e9f0a1b2c3",
  ),
  // hashes and encoded blobs
  keep(
    "hash",
    "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 ok",
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ),
  keep(
    "hash",
    "sha1 da39a3ee5e6b4b0d3255bfef95601890afd80709 ok",
    "da39a3ee5e6b4b0d3255bfef95601890afd80709",
  ),
  keep(
    "hash",
    "md5 9e107d9d372bb6826bd81d3542a419d6 ok",
    "9e107d9d372bb6826bd81d3542a419d6",
  ),
  keep("hash", "token QWNtZSBBIHJlcG9ydA== expired", "QWNtZSBBIHJlcG9ydA=="),
  // ids and codes
  keep("id-code", "Faktura INV-2024-0042 je splatná.", "INV-2024-0042"),
  keep("id-code", "Kód ACM3A-77 je neplatný.", "ACM3A-77"),
  keep("id-code", "order zeta9f3c21 shipped", "zeta9f3c21"),
  keep("id-code", "ref ORB1S-55 closed", "ORB1S-55"),
  keep("id-code", "SKU ZT4471Z out of stock", "ZT4471Z"),
  keep("id-code", "variable acmeA_total reset", "acmeA_total"),
  // markers
  keep("marker", "before ⟦field-acfe-01⟧ after", "⟦field-acfe-01⟧"),
  keep("marker", "insert {{clause_ref}} here", "{{clause_ref}}"),
  keep("marker", "see <<marker:zeta9>> below", "<<marker:zeta9>>"),
  keep(
    "marker",
    "text [[[__field_marker_3__]]] text",
    "[[[__field_marker_3__]]]",
  ),
  keep("marker", "section %%ACMEA_SECTION%% end", "%%ACMEA_SECTION%%"),
  // ordinary words close to short entries
  keep("ordinary-word", "This clause applies to both parties.", "clause"),
  keep("ordinary-word", "One acre of land was sold.", "acre"),
  keep("ordinary-word", "They came early.", "came"),
  keep("ordinary-word", "Treatment for acne is covered.", "acne"),
  keep("ordinary-word", "Use a marker on page two.", "marker"),
  keep("ordinary-word", "Both parties are willing to settle.", "willing"),
  keep("ordinary-word", "A stable orbit was reached.", "orbit"),
  keep("ordinary-word", "The zebra crossing is closed.", "zebra"),
  keep("ordinary-word", "Meta fields are optional.", "Meta"),
  keep("ordinary-word", "The data room opens Monday.", "data"),
  keep("ordinary-word", "Akce a smlouva jsou v příloze.", "Akce a"),
  keep("ordinary-word", "Beta verze vyjde v pondělí.", "Beta verze"),
  keep("ordinary-word", "Nová smlouva nahrazuje starou.", "Nová"),
  keep("ordinary-word", "Nováček nastoupil v pondělí.", "Nováček"),
  keep("ordinary-word", "Novátor získal cenu.", "Novátor"),
  keep("ordinary-word", "Na orbitu vyletěla družice.", "orbitu"),
  keep("ordinary-word", "Žena podala návrh.", "Žena"),
  keep("ordinary-word", "Prajem šťastnú cestu.", "šťastnú"),
  keep("ordinary-word", "Bol to šťastný deň.", "šťastný"),
  keep("ordinary-word", "Kováč opravil bránu.", "Kováč"),
  keep("ordinary-word", "Marže činí deset procent.", "Marže"),
  keep("ordinary-word", "Obec vydala rozhodnutí.", "Obec"),
  // words next to a true hit
  keep("adjacent-word", "Acme A signed the deal.", "signed"),
  keep("adjacent-word", "Zeta podepsala smlouvu.", "podepsala"),
  keep("adjacent-word", "Orbis schválil návrh.", "schválil"),
  keep("adjacent-word", "Novákovi zaslal dopis.", "zaslal"),
  keep("adjacent-word", "Marie Dvořáková uvedla, že nesouhlasí.", "uvedla"),
  keep("adjacent-word", "Beta Trading s.r.o. dodala zboží.", "dodala"),
  keep("adjacent-word", "Harriet Wellbourne confirmed receipt.", "confirmed"),
  keep("adjacent-word", "Ľubomír Šťastný uviedol dôvody.", "uviedol"),
  keep("adjacent-word", "Smlouvu uzavřela Acme A.", "uzavřela"),
  keep("adjacent-word", "Countersigned Zeta.", "Countersigned"),
  // template fields built around an entry, not spelled as the entry
  keep("template-field", "Šablona {{zeta_01}} je hotová.", "{{zeta_01}}"),
  keep("template-field", "Šablona [[orbis2024]] je hotová.", "[[orbis2024]]"),
  keep("template-field", "Šablona {{acme_a_01}} je hotová.", "{{acme_a_01}}"),
  keep("template-field", "Pole <<zeta2024>> je prázdné.", "<<zeta2024>>"),
  keep("template-field", "Šablona [[novák_2024]] je hotová.", "[[novák_2024]]"),
  keep(
    "template-field",
    "Šablona <<token:orbis7>> je hotová.",
    "<<token:orbis7>>",
  ),
  // organization words in another order: word orders are for people only
  keep(
    "reordered-organization",
    "The Analytics Northfield team met on Monday.",
    "Analytics Northfield",
  ),
  keep(
    "reordered-organization",
    "Ve verzi Trading Beta je chyba.",
    "Trading Beta",
  ),
  // other names and words in a script without letter case
  keep(
    "uncased-script-near-miss",
    "მოპასუხე: ნინო გელაშვილი",
    "ნინო გელაშვილი",
  ),
  keep("uncased-script-near-miss", "მოსარჩელე: თამარ ბერიძე", "თამარ ბერიძე"),
  keep("uncased-script-near-miss", "ბერი მონასტერში ცხოვრობს.", "ბერი"),
];

/** Exact identifiers the chat boundary forces into redaction. */
export const FORCED_VALUE_IDS = [
  "5f0c2a9e-7b1d-4c3a-9e8f-1a2b3c4d5e6f",
  "c3a91f04-6d2e-4b8a-a1f7-0e9d8c7b6a51",
] as const;

const [forcedOrgId, forcedScopeId] = FORCED_VALUE_IDS;

/**
 * Cases evaluated with {@link FORCED_VALUE_IDS} as forced values. The keep
 * cases from {@link NAME_MATCHING_CASES} are re-run in that mode too, with the
 * forced values present in a sibling field so they are active.
 */
export const FORCED_VALUE_CASES: readonly NameMatchingCase[] = [
  redact("forced-exact", `organization ${forcedOrgId} archived`, forcedOrgId),
  redact("forced-exact", `scope ${forcedScopeId} closed`, forcedScopeId),
  redact(
    "forced-case",
    `ORG ${forcedOrgId.toUpperCase()} ARCHIVED`,
    forcedOrgId.toUpperCase(),
  ),
  redact("forced-embedded", `GET /orgs/${forcedOrgId}/files`, forcedOrgId),
  redact("forced-embedded", `{"scope":"${forcedScopeId}"}`, forcedScopeId),
  keep(
    "forced-near-miss",
    "organization 5f0c2a9e-7b1d-4c3a-9e8f-1a2b3c4d5e6a archived",
    "5f0c2a9e-7b1d-4c3a-9e8f-1a2b3c4d5e6a",
  ),
  keep(
    "forced-near-miss",
    "organization 5f0c2a9e-7b1d-4c3a-9e8f-1a2b3c4d5eaa archived",
    "5f0c2a9e-7b1d-4c3a-9e8f-1a2b3c4d5eaa",
  ),
  keep(
    "forced-near-miss",
    "scope c3a91f04-6d2e-4b8a-a1f7-0e9d8c7b6a5 closed",
    "c3a91f04-6d2e-4b8a-a1f7-0e9d8c7b6a5",
  ),
  keep(
    "forced-other-id",
    "row 1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081 updated",
    "1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081",
  ),
  keep("forced-other-id", "row 5f0c2a9e7b1d4c3a updated", "5f0c2a9e7b1d4c3a"),
  keep(
    "forced-adjacent-word",
    `organization ${forcedOrgId} archived`,
    "archived",
  ),
  keep("forced-adjacent-word", `scope ${forcedScopeId} closed`, "closed"),
  keep(
    "forced-adjacent-word",
    `Workspace ${forcedScopeId}, then the report.`,
    "then",
  ),
];
