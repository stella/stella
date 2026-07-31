/**
 * What a citation is doing: invoking authority, or naming the case's own
 * procedural history.
 *
 * A decision under review cites two very different things. It invokes
 * precedent — "srov. rozsudek Nejvyššího soudu ..." — and it names the
 * judgment it is reviewing, together with the first-instance file number,
 * in its recitals. Both are extracted as citations, but only the first is
 * an endorsement of authority.
 *
 * Conflating them costs twice over. Procedural references never resolve,
 * because first- and second-instance judgments are largely unpublished, so
 * counting them makes a working citator look broken. And if they reached
 * the citation graph they would inflate the authority of whatever happened
 * to be appealed, which is the opposite of what authority means.
 */

/** Closed set; persisted, so a CHECK constraint mirrors it in the schema. */
export const CITATION_KIND = {
  PRECEDENT: "precedent",
  PROCEDURAL: "procedural",
} as const;

export type CitationKind = (typeof CITATION_KIND)[keyof typeof CITATION_KIND];

/**
 * Registries of courts whose decisions are published as standalone
 * documents and therefore citable as authority. Everything else is
 * first- or second-instance, where a reference is almost always the
 * case's own history.
 *
 * The registry is a prior, not a verdict: a published lower-court
 * decision can be cited as authority (a regional judgment reported in
 * Sb. NSS), so context wins where it speaks.
 */
const AUTHORITY_REGISTRIES = new Set([
  // Czech Supreme Court
  "cdo",
  "tdo",
  "odo",
  "nd",
  // Czech Supreme Administrative Court
  "as",
  "afs",
  "azs",
  "ads",
  "ars",
  "aps",
  "ao",
  "konf",
  // Constitutional courts
  "ús",
  "us",
  // Polish Supreme Court
  "csk",
  "ck",
  "czp",
  "uzp",
  "kzp",
  "cskp",
  // Slovak Supreme Court
  "sžo",
  "sž",
  "obdo",
  "cdo",
]);

/**
 * Phrases that mark the recitals: the appeal, the judgment under review,
 * the court below. Deliberately morphological stems rather than whole
 * words — Czech and Slovak inflect heavily, and matching stems keeps one
 * list working across cases.
 */
const PROCEDURAL_CUE =
  /napaden|proti\s+(?:rozsudk|usnesen)|odvol[áa]n|dovol[áa]n[íi]\s+(?:žalovan|žalobc)|soud[ue]?\s+prvn[íi]ho\s+stupn|prvostupňov|potvrdil|zrušil\s+a\s+vr[áa]til|vedl[ei]?\s+u\s+|pobočka\s+v/iu;

/**
 * Phrases that mark an authority being invoked. `srov.` (compare) and
 * `viz` (see) are the strongest: they exist only to point at precedent.
 */
const PRECEDENT_CUE =
  /srov\.|srovnej|viz\s|judikat|ust[áa]len|pr[áa]vn[íi]\s+n[áa]zor|dovodil|vyslovil|konstatoval|st[áa]l[áa]\s+praxe|ve\s+sv[ée]m\s+rozhodnut/iu;

/**
 * Drop the citation prefix so the registry token is first. Spelled out
 * per language rather than matched generically: `sygn. akt` carries one
 * dot and `sp. zn.` two, and a pattern loose enough for both also eats
 * the registry it is meant to expose.
 */
const withoutPrefix = (text: string): string =>
  text
    .replace(/^\s*sp\.\s*zn\.:?\s*/iu, "")
    .replace(/^\s*[čc]\.\s*j\.:?\s*/iu, "")
    .replace(/^\s*sygn\.\s*(?:akt\s+)?/iu, "")
    .trim();

/** The registry token of a case number: `21 Cdo 1234/2020` -> `cdo`. */
const registryOf = (citationText: string): string | null => {
  const roman = /^\s*[IVX]+\.?\s*(?<reg>[A-Za-zÁ-Žá-ž]{1,5})/u.exec(
    citationText,
  );
  const arabic = /^\s*\d{1,3}\s*(?<reg>[A-Za-zÁ-Žá-ž]{1,6})/u.exec(
    citationText,
  );
  const us = /ÚS|US/u.exec(citationText);
  const raw = roman?.groups?.["reg"] ?? arabic?.groups?.["reg"] ?? us?.[0];
  return raw === undefined ? null : raw.toLowerCase();
};

export type ClassifyCitationInput = {
  /** The citation as it appears, prefix and all. */
  citationText: string;
  /** Text around the citation; null when it could not be located. */
  context: string | null;
};

/**
 * Context decides when it speaks unambiguously, because the same registry
 * can appear in either role. Where context is silent or says both, the
 * registry's publication status is the fallback.
 */
export const classifyCitation = ({
  citationText,
  context,
}: ClassifyCitationInput): CitationKind => {
  if (context !== null) {
    const procedural = PROCEDURAL_CUE.test(context);
    const precedent = PRECEDENT_CUE.test(context);
    if (procedural !== precedent) {
      return procedural ? CITATION_KIND.PROCEDURAL : CITATION_KIND.PRECEDENT;
    }
  }

  const registry = registryOf(withoutPrefix(citationText));
  if (registry !== null && AUTHORITY_REGISTRIES.has(registry)) {
    return CITATION_KIND.PRECEDENT;
  }
  return CITATION_KIND.PROCEDURAL;
};
