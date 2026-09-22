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

import { panic } from "better-result";

import { hungarianCitationForm } from "@/api/handlers/case-law/ingestion/citation-extractor";
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
  // The criminal register for a complaint for breach of law ("stížnost pro
  // porušení zákona", 7 Tz 62/90), which only the Supreme Court decides and
  // which it publishes. Its numbers are old (the remedy predates the 1993
  // split and is rare since), so a decision reaching for one is reaching for
  // settled authority, the tier the rest of this court's registers sit on.
  "tz",
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
  // Polish appellate courts ("sąd apelacyjny"), whose marks all carry the
  // `A` prefix: civil (`ACa`), criminal (`AKa`), social-insurance (`AUa`),
  // commercial (`AGa`) and labour (`APa`), each with a `z` sibling for the
  // interlocutory register ("zażalenie"). Second instance, so the paragraph
  // above would put them outside this set — but they are published in full
  // and cited as authority, which is what the prior is asking about. Their
  // own procedural history is the district and regional registers (`C`, `K`,
  // `U`, `GC`, `P`), which stay unlisted and so still fall through.
  //
  // The cost of listing them is the supreme-court decision that names the
  // appellate judgment it is reviewing: on the registry tier that now reads
  // as authority. The Polish recital cues below are what catch it one tier
  // earlier, which is where a statement about the case belongs.
  "aca",
  "aka",
  "aua",
  "aga",
  "apa",
  "acz",
  "akz",
  "auz",
  "agz",
  "apz",
  // Polish Supreme Administrative Court (NSA): the cassation registers of
  // its three chambers (`OSK` general-administrative, `FSK` financial, `GSK`
  // commercial), the resolution registers those chambers use to unify
  // practice (`OPS`, `FPS`, `GPS`), and `ONP` for the legal questions
  // referred to it.
  //
  // The regional administrative courts (WSA) are deliberately absent. Their
  // mark is two tokens, a register and a seat ("I SA/Wa 123/20"), and the
  // reader below stops at the slash: what it would key on is the bare `sa`,
  // the seat dropped, which is no longer the WSA mark at all. A two-letter
  // token keyed without the half that identifies it is what this set cannot
  // carry, because a wrong entry promotes silently and in bulk. WSA belongs
  // here once `registryOf` reads the slash form.
  "osk",
  "fsk",
  "gsk",
  "ops",
  "fps",
  "gps",
  "onp",
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
 * The Kúria's registers whose decisions are published and cited as
 * authority: the review registers of its civil, commercial, criminal, labour
 * and administrative chambers, and the uniformity panel's. Kept apart from
 * `AUTHORITY_REGISTRIES` because the Hungarian registry is read by the
 * Hungarian docket grammar, not by `registryOf`, and a mark in one set says
 * nothing about the same letters in the other. The appeal registers (`Pf`,
 * `Gf`, `Bf`) are absent: the regional courts of appeal use them too, and a
 * Kúria decision reaches them as the judgment under review.
 */
const HUNGARIAN_AUTHORITY_REGISTRIES = new Set([
  "pfv",
  "gfv",
  "bfv",
  "mfv",
  "kfv",
  "jpe",
]);

/**
 * The registry tier: whether the cited court's publication status makes the
 * citation authority. A Hungarian published designation (a reporter entry, a
 * uniformity decision, an opinion, a Constitutional Court decision) is
 * authority by being published.
 */
const isAuthorityByRegistry = (citationText: string): boolean => {
  const hungarian = hungarianCitationForm(citationText);
  if (hungarian === null) {
    const registry = registryOf(withoutPrefix(citationText));
    return registry !== null && AUTHORITY_REGISTRIES.has(registry);
  }
  switch (hungarian.type) {
    case "published":
      return true;
    case "docket":
      return HUNGARIAN_AUTHORITY_REGISTRIES.has(hungarian.registry);
    default: {
      hungarian satisfies never;
      return panic(`Unhandled Hungarian citation form: ${String(hungarian)}`);
    }
  }
};

/**
 * Phrases that mark the recitals: the appeal, the judgment under review,
 * the court below. Deliberately morphological stems rather than whole
 * words — Czech, Slovak and Polish all inflect heavily, and matching stems
 * keeps one list working across cases.
 *
 * The Polish pair is `zaskarżon` (the judgment "under appeal", in whatever
 * case the sentence puts it) and `od\s+wyroku` (what an appeal or a
 * cassation is brought *from*). `sygn. akt` is not here and should not be:
 * it is the citation prefix itself and appears on authority and recital
 * alike, so it would push every Polish citation with a spelled-out prefix
 * onto this side of the tie.
 */
const PROCEDURAL_CUE =
  /napaden|proti\s+(?:rozsudk|usnesen)|odvol[áa]n|dovol[áa]n[íi]\s+(?:žalovan|žalobc)|soud[ue]?\s+prvn[íi]ho\s+stupn|prvostupňov|potvrdil|zrušil\s+a\s+vr[áa]til|vedl[ei]?\s+u\s+|pobočka\s+v|v\s+konan[íi]\s+veden[oe]m|veden[eé]j\s+\p{L}+\s+s[úu]dom\s+pod|postupom\s+(?:okresn|krajsk|najvyšš)|a\s+takto\s+rozhodol|zaskarżon|od\s+wyroku/iu;

/**
 * Phrases that mark an authority being invoked. `srov.` (compare) and
 * `viz` (see) are the strongest: they exist only to point at precedent.
 * Slovak spells its verbs with `š` (`konštatoval`), so the stems are listed
 * per language; a recital cue next to one of these is a tie, and the
 * registry decides.
 *
 * Polish contributes its own two pointing abbreviations (`por.`, `zob.`),
 * the three ways it says "likewise" (`tak też`, `podobnie`, `zgodnie z`),
 * the coordinate that introduces a cited holding (`w wyroku z dnia`,
 * `w uchwale`), and the two stems the settled-case-law formula is built on
 * (`ugruntowan`, `utrwalon` — "ugruntowane orzecznictwo", "utrwalona linia
 * orzecznicza"), the counterpart of the `ustálen` already listed for Czech.
 *
 * A `nález Ústavního soudu` is a constitutional judgment on the merits, and
 * a decision reaches for one to say what the constitution requires: the
 * phrase is the invocation, whether or not a pointing verb introduces it
 * ("(nález Ústavního soudu sp. zn. I. ÚS 1135/17, ze dne 1. 11. 2017)").
 *
 * Czech and Slovak also point with `poukazuje na` / `poukázal na`, but the
 * verb alone means only "points out", and a party points out the judgment
 * under review as readily as a precedent. The cue is the whole phrase -
 * pointing at a *decision* - so the word naming the document is what carries
 * it ("poukazuje na usnesení Nejvyššího soudu sp. zn. 3 Tdo 759/2020").
 * Where the same sentence also names the case's own history the two cue sets
 * tie, as they should, and the registry decides.
 */
const PRECEDENT_CUE =
  /srov\.|srovnej|viz\s|judikat|ust[áa]len|pr[áa]vn[íi]\s+n[áa]zor|dovodil|vyslovil|kon[sš]tatoval|st[áa]l[áa]\s+praxe|ve\s+sv[ée]m\s+rozhodnut|n[áa]lez\p{Ll}*\s+[ÚU]stavn|pouk[áa]z\p{Ll}*\s+(?:i\s+)?na\s+(?:\p{L}+\s+){0,2}(?:usnesen|rozhodnut|rozsudek|rozsudok|n[áa]lez|stanovisk|judik)|porov\.|pozri|obdobne|vo\s+svojom\s+rozhodnut|v\s+s[úu]lade\s+s|por\.|zob\.|tak\s+też|podobnie|zgodnie\s+z|w\s+wyroku\s+z\s+dnia|w\s+uchwale|ugruntowan|utrwalon/iu;

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
const registryOf = (rawCitationText: string): string | null => {
  // A mark is not a letter: `\p{L}` reads a decomposed "Ú" (U+0055 U+0301)
  // as a bare "U", and the Constitutional Court's registry then looks like
  // an unlisted one. Publishers serve both normalization forms and the
  // document text keeps whichever it was served, so the reading composes
  // first. Only this lookup key is folded; nothing stored is touched.
  const citationText = rawCitationText.normalize("NFC");
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

  return {
    kind: isAuthorityByRegistry(citationText)
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
