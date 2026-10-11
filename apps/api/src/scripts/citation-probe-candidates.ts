// A greedy detector tail can swallow a second prefixed reference into one
// candidate, hiding it behind the first one's coverage; cutting at any
// embedded prefix leaves each candidate with its own prefix only.
export const standaloneCandidate = (match: string): string => {
  const candidate = match.replaceAll(/\s+/gu, " ").trim();
  const embedded = candidate
    .slice(4)
    .search(/(?:sp\.\s?zn\.|sen\.\s?zn\.|sygn\.|[čc]\.\s?j\.)/iu);
  return embedded === -1 ? candidate : candidate.slice(0, embedded + 4).trim();
};

// Residual classes that are not court decisions and never will be:
// administrative-authority file numbers (letter blocks joined by dashes),
// anonymization placeholders, and statute/collection references.
const BENIGN: readonly RegExp[] = [
  /[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]{2,8}[-–][\w/–-]{0,30}\d/u,
  /X{2,}/u,
  /\b\d{1,5}\/\d{2,4}\s{1,3}Sb\b/u,
  /\bZb\.\s*z\b/u,
  // Polish procurement-tribunal rulings (KIO/UZP): quasi-judicial, not a
  // court source the corpus ingests, so never a resolvable citation.
  /\bKIO ?\/? ?UZP\b/u,
  // KIO's own docket format ("KIO/2462/10", "KIO 2475 /10"): same
  // out-of-corpus tribunal, cited by case number rather than by name.
  /\bKIO\s{0,1}\/?\s{0,1}\d{1,5}\s{0,1}\/\s{0,1}\d{2,4}\b/u,
  // A case-number prefix ("sp. zn.", "sen. zn.", "sygn.[ akt]", "č. j.")
  // with no digit anywhere in the captured tail is never a real citation:
  // every actual docket carries a number. Covers Polish anonymization
  // placeholders, where the detector's own trailing-paren exclusion
  // truncates the candidate right before the redaction ("sygn. akt II Ca"
  // from "sygn. akt II Ca (…)"), and self-references such as "sygn. j.w."
  // ("as above").
  /^(?:sp\.\s{0,3}zn\.|sen\.\s{0,3}zn\.|sygn\.(?:\s{1,3}akt)?|[čc]\.\s{0,3}j\.:?)[^\d]{0,45}$/iu,
  // Administrative-authority "č. j." reference (tax office, land registry):
  // two or more purely numeric segments joined by slashes or hyphens, e.g.
  // "č. j. 11055/01/332960/2959" (Finanční úřad), "č.j. 192859/07"
  // (protocol number in a tax proceeding), "č.j. 11273/09-1200-700346"
  // (Finanční ředitelství, trailing dash-joined department blocks), "č.j.
  // 65050/08/305921704713" (dodatečný platební výměr, 12-digit final
  // segment). A real court docket always carries a letter registry between
  // the chamber digit and the docket number (CASE_NUMBER_BODY in the
  // extractor); an all-numeric reference is never a court citation, whatever
  // its segment count or separator. The lookahead excludes a following
  // letter, digit, or slash so a longer or mixed-format reference
  // ("123/45/678/ABC", a 7-segment chain, or a final segment beyond the
  // digit cap) is never silently truncated to a benign-looking prefix.
  /[čc]\.\s{0,3}j\.:?\s{0,3}\d{1,8}(?:[/-]\d{1,14}){1,5}(?![\p{L}\d/])/u,
  // The letter-segment form of the same administrative reference, where a
  // department code sits in one of the slash-joined segments: "č. j.
  // KK/547/DS/19-3" (regional authority), "č. j. 2194/OD/19-4/Rsz" (city
  // transport department), "č. j. 5/OH/8433/01-Sa/533" (environmental
  // inspectorate). Two properties separate these from a court docket: the
  // reference carries no whitespace, and it joins four or more segments,
  // while the widest court docket the extractor accepts
  // (CASE_NUMBER_BODY_COMMA) reaches three. The leading lookahead keeps the
  // no-whitespace chamber+registry spelling ("36Co/52/53/2023") out, and the
  // trailing one prevents a longer or oversized reference from matching a
  // benign-looking prefix of itself.
  /[čc]\.\s{0,3}j\.:?\s{0,3}(?!\d{1,3}\p{L}{1,6}\/)[\p{L}\d-]{1,10}(?:\/[\p{L}\d-]{1,10}){3,5}(?![\p{L}\d/-])/u,
  // The same administrative reference written with a whitespace-separated
  // authority code: "č.j. MCO5 155283/2019/ODP/Mach" (městská část office),
  // "sp.zn. MCO5/OSU/1827/2017/Šev/Sm.p.967" (its sp. zn. spelling). The
  // authority code is uppercase letters closed by a digit, which no court
  // docket in the corpus opens with: a docket leads with the chamber
  // number ("8 C/18/2008", "36Co/52/53/2023"), so the letters-then-digit
  // head separates the two without needing the prefix to decide. Three or
  // more slash-joined segments follow, one past the widest court docket
  // (CASE_NUMBER_BODY_COMMA); the trailing lookahead keeps a longer
  // reference from matching a benign-looking prefix of itself.
  /\b\p{Lu}{2,6}\d{1,2}[\s/][\p{L}\d]{1,12}(?:\/[\p{L}\d.]{1,14}){2,5}(?![\p{L}\d/])/u,
  // Polish prosecutor-office case files ("sygn. akt V Ds. 41/10"): the Ds.
  // registry belongs to the prosecution service, not to a court, so the
  // corpus never holds the referenced file.
  /\b(?:[IVX]{1,4}\s{0,2}|\d{1,3}\s{0,2})?Ds[.\s]\s{0,3}\d{1,5}[./]\d{2,4}\b/u,
  // Czech anonymization placeholder standing where the docket belongs
  // ("sp. zn. Anonymizováno byl podán dne 2. 1. 2025"). The no-digit-tail
  // rule above misses it whenever the detector's greedy tail reaches into
  // following prose that carries a date.
  /^(?:sp\.\s{0,3}zn\.|sen\.\s{0,3}zn\.|sygn\.(?:\s{1,3}akt)?|[čc]\.\s{0,3}j\.:?)\s{0,3}[Aa]nonymizov[aá]no\b/u,
  // Czech regional-authority file number with a space-separated office
  // code ("č. j. KUAB 12345/2020"): every krajský úřad code opens with
  // "KU", which no court registry does, and the reference is not a court
  // docket the corpus can hold.
  /^[čc]\.\s{0,3}j\.:?\s{0,3}KU\p{Lu}{2,4}\s{1,3}\d{1,7}\/\d{4}(?![\p{L}\d/-])/u,
  // A purely numeric "number/two-digit-year" after a case-number prefix
  // ("sygn. akt 12345/01", "sp. zn. 12345/01"): the application-number
  // form of the international human-rights court, outside the corpus.
  // Every domestic docket carries a letter registry before the number.
  /^(?:sp\.\s{0,3}zn\.|sygn\.(?:\s{1,3}akt)?)\s{0,3}\d{3,5}\/\d{2}(?![\p{L}\d/-])/u,
];

export const isBenign = (candidate: string): boolean =>
  BENIGN.some((re) => re.test(candidate));
