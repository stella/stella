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

import { isRecord } from "@/api/lib/type-guards";

/** Closed set; persisted, so a CHECK constraint mirrors it in the schema. */
export const CITATION_KIND = {
  PRECEDENT: "precedent",
  PROCEDURAL: "procedural",
} as const;

export type CitationKind = (typeof CITATION_KIND)[keyof typeof CITATION_KIND];

/** The same values as a list, for the column's `enum` and the CHECK. */
export const CITATION_KINDS = [
  CITATION_KIND.PRECEDENT,
  CITATION_KIND.PROCEDURAL,
] as const;

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
  // Czech Supreme Court kolegium opinions ("stanoviska"): civil-and-
  // commercial (Cpjn 203/2010) and criminal (Tpjn 300/2017). A stanovisko is
  // issued to unify divergent practice, so it is authority by construction.
  // The citation extractor already recognises the bare `Cpjn`/`Tpjn` forms;
  // the registry reader below is what lets them reach this set.
  "cpjn",
  "tpjn",
  // The commercial kolegium's own opinion register, from before that
  // kolegium merged into the civil-and-commercial one. Historical: the
  // published set is tiny (Opjn 8/2006), but those opinions are still cited.
  "opjn",
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
  // Polish Supreme Court legal-question resolutions ("uchwały") of the
  // labour chamber, the sibling of the `uzp`/`czp`/`kzp` marks already
  // listed. Cited with a Roman chamber prefix that drifts as chambers are
  // reorganised ("III PZP 1/21"), so only the mark itself is keyed on.
  "pzp",
  // Slovak Supreme Court. `cdo` is shared with the Czech Supreme Court and
  // is listed once, above.
  "sžo",
  "sž",
  "obdo",
  // Slovak grand chambers ("veľký senát"), which sit precisely to depart
  // from settled practice: the Supreme Court's civil and commercial ones
  // ("1VCdo/9/2025", "1VObdo/2/2026"), and the Supreme Administrative
  // Court's ("1 SVs 1/2021"). There is deliberately no criminal entry:
  // Slovak criminal law has no veľký senát, and the unifying senates that
  // stand in for it have published nothing to cite yet.
  "vcdo",
  "vobdo",
  "svs",
]);

/**
 * Phrases that mark the recitals: the appeal, the judgment under review,
 * the court below. Deliberately morphological stems rather than whole
 * words — Czech and Slovak inflect heavily, and matching stems keeps one
 * list working across cases.
 */
const PROCEDURAL_CUE =
  /napaden|proti\s+(?:rozsudk|usnesen)|odvol[áa]n|dovol[áa]n[íi]\s+(?:žalovan|žalobc)|soud[ue]?\s+prvn[íi]ho\s+stupn|prvostupňov|potvrdil|zrušil\s+a\s+vr[áa]til|vedl[ei]?\s+u\s+|pobočka\s+v|v\s+konan[íi]\s+veden[oe]m|veden[eé]j\s+\p{L}+\s+s[úu]dom\s+pod|postupom\s+(?:okresn|krajsk|najvyšš)|a\s+takto\s+rozhodol/iu;

/**
 * Phrases that mark an authority being invoked. `srov.` (compare) and
 * `viz` (see) are the strongest: they exist only to point at precedent.
 * Slovak spells its verbs with `š` (`konštatoval`), so the stems are listed
 * per language; a recital cue next to one of these is a tie, and the
 * registry decides.
 */
const PRECEDENT_CUE =
  /srov\.|srovnej|viz\s|judikat|ust[áa]len|pr[áa]vn[íi]\s+n[áa]zor|dovodil|vyslovil|kon[sš]tatoval|st[áa]l[áa]\s+praxe|ve\s+sv[ée]m\s+rozhodnut|porov\.|pozri|obdobne|vo\s+svojom\s+rozhodnut|v\s+s[úu]lade\s+s/iu;

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

/**
 * The registry token of a case number: `21 Cdo 1234/2020` -> `cdo`.
 *
 * Most marks are preceded by a chamber number, Roman or Arabic. Some are
 * not: a Czech kolegium opinion is `Cpjn 203/2010`, with no chamber at all,
 * because the whole kolegium issued it. That form is read last and only when
 * the digits of the case number follow it directly, so it cannot pick a word
 * out of ordinary prose. It never promotes on its own either: an unlisted
 * mark still falls through to procedural, exactly as a null did.
 *
 * The mark is matched as `\p{L}`, the same class the citation extractor
 * uses. The `Á-Ž`/`á-ž` ranges this used to spell out are code-point ranges,
 * not letter ranges: they overlap each other and take in `×` and `÷`, which
 * sit between the accented blocks. Whatever they match is looked up in a
 * closed set, so the sloppiness never promoted anything, but there is no
 * reason for two spellings of "a letter" in one file.
 */
const registryOf = (citationText: string): string | null => {
  const roman = /^\s*[IVX]+\.?\s*(?<reg>\p{L}{1,5})/u.exec(citationText);
  const arabic = /^\s*\d{1,3}\s*(?<reg>\p{L}{1,6})/u.exec(citationText);
  const us = /ÚS|US/u.exec(citationText);
  const bare = /^\s*(?<reg>\p{L}{2,6})\.?\s+\d/u.exec(citationText);
  const raw =
    roman?.groups?.["reg"] ??
    arabic?.groups?.["reg"] ??
    us?.[0] ??
    bare?.groups?.["reg"];
  return raw === undefined ? null : raw.toLowerCase();
};

/**
 * Case numbers the publisher itself names as this decision's procedural
 * history — SAOS `lowerCourtJudgments`, for instance. Canonical keys, so
 * they compare against a citation's own key regardless of how either side
 * spells the number.
 *
 * This is the only evidence that is not inference: the court is stating
 * which judgments the case passed through. Where it exists it settles the
 * question, and the cues below never get consulted.
 */
export type ProceduralKeys = ReadonlySet<string>;

export type ClassifyCitationInput = {
  /** The citation as it appears, prefix and all. */
  citationText: string;
  /** Text around the citation; null when it could not be located. */
  context: string | null;
  /** The citation under `bareCitationKey`, for comparing against publisher keys. */
  citationKey?: string | null | undefined;
  /** Publisher-declared procedural history; see `ProceduralKeys`. */
  proceduralKeys?: ProceduralKeys | undefined;
};

/** Which tier of evidence decided a classification. */
export const CITATION_KIND_EVIDENCE = {
  /** The publisher named this judgment as the case's own history. */
  PUBLISHER: "publisher",
  /** The surrounding sentence carried exactly one of the two cue sets. */
  CONTEXT: "context",
  /** Neither spoke; the cited court's publication status decided. */
  REGISTRY: "registry",
} as const;

export type CitationKindEvidence =
  (typeof CITATION_KIND_EVIDENCE)[keyof typeof CITATION_KIND_EVIDENCE];

export type CitationKindVerdict = {
  kind: CitationKind;
  evidence: CitationKindEvidence;
};

/**
 * Classification with the reason attached.
 *
 * Evidence in descending order of authority: what the publisher declares,
 * then what the surrounding sentence says, then whether the cited court
 * publishes at all. Each step only runs because the one above it was
 * silent.
 */
export const classifyCitationVerdict = ({
  citationText,
  context,
  citationKey,
  proceduralKeys,
}: ClassifyCitationInput): CitationKindVerdict => {
  // The publisher's own account of the case's history outranks anything
  // read out of the prose: it is a statement, not a reading of one.
  if (
    citationKey !== null &&
    citationKey !== undefined &&
    proceduralKeys?.has(citationKey) === true
  ) {
    return {
      kind: CITATION_KIND.PROCEDURAL,
      evidence: CITATION_KIND_EVIDENCE.PUBLISHER,
    };
  }

  if (context !== null) {
    const procedural = PROCEDURAL_CUE.test(context);
    const precedent = PRECEDENT_CUE.test(context);
    if (procedural !== precedent) {
      return {
        kind: procedural ? CITATION_KIND.PROCEDURAL : CITATION_KIND.PRECEDENT,
        evidence: CITATION_KIND_EVIDENCE.CONTEXT,
      };
    }
  }

  const registry = registryOf(withoutPrefix(citationText));
  return {
    kind:
      registry !== null && AUTHORITY_REGISTRIES.has(registry)
        ? CITATION_KIND.PRECEDENT
        : CITATION_KIND.PROCEDURAL,
    evidence: CITATION_KIND_EVIDENCE.REGISTRY,
  };
};

export const classifyCitation = (input: ClassifyCitationInput): CitationKind =>
  classifyCitationVerdict(input).kind;

/**
 * How the heuristics would have classified this citation with the
 * publisher's account withheld.
 *
 * Where a publisher states a case's procedural history, that statement is
 * a free label for the tiers below it — and the only way to know whether
 * the cue lists work on sources that publish no such list. The comparison
 * is one-sided: a publisher naming a judgment proves it *is* procedural,
 * but its silence proves nothing, so this measures how much of the known
 * procedural set the heuristics recover, never how much they over-call.
 */
export const classifyWithoutPublisher = (
  input: ClassifyCitationInput,
): CitationKindVerdict =>
  classifyCitationVerdict({
    citationText: input.citationText,
    context: input.context,
  });

/**
 * Case numbers a publisher names as the decision's own procedural history.
 *
 * Only fields that mean exactly that are read. `referencedCourtCases` is
 * deliberately excluded: it is the publisher's list of authorities the
 * decision cites, which is the opposite claim.
 */
const PROCEDURAL_METADATA_FIELDS = ["lowerCourtJudgments"] as const;

/** Publishers list these either as bare strings or as `{ caseNumber }`. */
const caseNumberOf = (entry: unknown): string | null => {
  if (typeof entry === "string") {
    return entry;
  }
  if (!isRecord(entry)) {
    return null;
  }
  const caseNumber = entry["caseNumber"];
  return typeof caseNumber === "string" ? caseNumber : null;
};

export const proceduralKeysFromMetadata = (
  metadata: Record<string, unknown> | null | undefined,
  toKey: (caseNumber: string) => string,
): ProceduralKeys => {
  const keys = new Set<string>();
  if (!metadata) {
    return keys;
  }
  for (const field of PROCEDURAL_METADATA_FIELDS) {
    const value = metadata[field];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      const caseNumber = caseNumberOf(entry);
      if (caseNumber === null) {
        continue;
      }
      const key = toKey(caseNumber);
      if (key.length > 0) {
        keys.add(key);
      }
    }
  }
  return keys;
};
