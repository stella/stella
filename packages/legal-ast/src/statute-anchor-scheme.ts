// parser-output-unchanged: Statute anchor grammars for readers and provision reads; decision parsers reach this module only through document-ast and call none of it.
// parser-output-unchanged: Minting and nesting provision anchors moved here serve provision keys and previews; decision parsers still call none of this module.
// parser-output-unchanged: Unnumbered statute wording is read only by provision reads and previews; decision parsers still call none of this module.
// parser-output-unchanged: Governing wording, unnumbered segments and ancestor paths serve statute provision reads only; decision parsers still call none of this module.
// parser-output-unchanged: Annex anchor grammars and the reading of a requested annex number serve statute reads only; decision parsers still call none of this module.
// parser-output-unchanged: The Hungarian gazette grammar and its annex spelling serve statute reads only; decision parsers still call none of this module.
/**
 * The grammar a publisher writes statute anchors in, and every reading of an
 * anchor's path that the readers, previews and provision reads make.
 *
 * A publisher stores a provision as a flat block stream, but each block's
 * stable anchor path names its place in the provision, in the publisher's
 * own grammar: e-Sbírka writes `par_72a-odst_1-pism_a-bod_1`, Slov-Lex
 * `paragraf-19.odsek-2.pismeno-l.bod-1.bod-1a`, the US Code `s1983/a/1`.
 * Which block nests under which, how deep a list item sits and which
 * designator it prints are all read here, through the scheme of the
 * statute's publisher, so no surface can cut a path on a separator of its
 * own.
 */
import { panic } from "better-result";

import { stripDiacritics } from "@stll/text-normalize";

import type { ParagraphListDepth } from "./document-ast.js";

/** The provision levels a publisher names in an anchor segment's kind. */
export type StatuteAnchorLevel =
  "section" | "article" | "subsection" | "letter" | "point";

/** The kind each level's segment opens with (`par`, `pismeno`). */
type StatuteAnchorKinds = Readonly<Record<StatuteAnchorLevel, string>>;

/**
 * How a publisher's anchors state their path, or why they state none.
 *
 * - `listed`: an anchor is segments joined by `segmentSeparator`; a segment
 *   is a kind and a value joined by `kindSeparator` (`pism_a`,
 *   `pismeno-a`), and `kinds` names the kind of each provision level.
 *   `listKinds` names the kinds that are list items, each with the
 *   shallowest depth it is drawn at; an item nested in another sits one
 *   level under it (`pism_b-pism_aa`, `bod-1.bod-1a`). `restatementSuffix`
 *   marks a segment that restates its subdivision (e-Sbírka's `~2`), or is
 *   null where the publisher marks none. `unnumberedAnchor` matches the
 *   anchor of wording the publisher numbers nowhere and files outside any
 *   path, or is null where it nests such wording in the path (Slov-Lex's
 *   `odsek-1.text2`). `unnumberedSegment` matches one segment naming such
 *   wording where the publisher files it under the unit it belongs to
 *   (`par_5-pism_e-frag_6070235`, `odsek-1.text2`, `paragraf-5.text`).
 *   `annexAnchors` match the anchor of an annex heading, each capturing the
 *   annex's designator (`3` of `pril_3`) as `designator`, or capturing
 *   nothing for an act's one unnumbered annex.
 * - `path`: anchors nest on `segmentSeparator`, but their segments name no
 *   list the reader can draw; `reason` says why.
 * - `whole`: anchors are read whole, so none nests under another; `reason`
 *   says why.
 */
export type StatuteAnchorScheme =
  | {
      type: "listed";
      kinds: StatuteAnchorKinds;
      kindSeparator: string;
      listKinds: Readonly<Record<string, ParagraphListDepth>>;
      restatementSuffix: RegExp | null;
      segmentSeparator: string;
      unnumberedAnchor: RegExp | null;
      unnumberedSegment: RegExp;
      annexAnchors: readonly RegExp[];
    }
  | { type: "path"; reason: string; segmentSeparator: string }
  | { type: "whole"; reason: string };

export type ListedAnchorScheme = Extract<
  StatuteAnchorScheme,
  { type: "listed" }
>;

const E_SBIRKA_KINDS = {
  section: "par",
  article: "cl",
  subsection: "odst",
  letter: "pism",
  point: "bod",
} as const satisfies StatuteAnchorKinds;

/**
 * e-Sbírka (Czechia): `par_72a-odst_1-pism_a-bod_1`, a duplicate `pism_c~2`.
 * A point sits two levels in even where a section opens it directly.
 */
export const E_SBIRKA_ANCHORS = {
  type: "listed",
  kinds: E_SBIRKA_KINDS,
  kindSeparator: "_",
  listKinds: { [E_SBIRKA_KINDS.letter]: 1, [E_SBIRKA_KINDS.point]: 2 },
  restatementSuffix: /~\d+$/u,
  segmentSeparator: "-",
  unnumberedAnchor: /^frag_\d+$/u,
  unnumberedSegment: /^frag_\d+$/u,
  // `pril_3`, `pril_2A`, `pril_A/1`, `pril_4:2`, and in a few older acts
  // `priloha_27`.
  annexAnchors: [
    /^pril_(?<designator>[^-]+)$/u,
    /^priloha_(?<designator>[^-]+)$/u,
  ],
} as const satisfies StatuteAnchorScheme;

const SLOV_LEX_KINDS = {
  section: "paragraf",
  article: "clanok",
  subsection: "odsek",
  letter: "pismeno",
  point: "bod",
} as const satisfies StatuteAnchorKinds;

/** Slov-Lex (Slovakia): `paragraf-19.odsek-2.pismeno-l.bod-1.bod-1a`. */
export const SLOV_LEX_ANCHORS = {
  type: "listed",
  kinds: SLOV_LEX_KINDS,
  kindSeparator: "-",
  listKinds: { [SLOV_LEX_KINDS.letter]: 1, [SLOV_LEX_KINDS.point]: 1 },
  restatementSuffix: null,
  segmentSeparator: ".",
  unnumberedAnchor: null,
  unnumberedSegment: /^text\d*$/u,
  // Every annex is a `prilohy.priloha-…` container whose id the publisher
  // spells from the annex's own title: `…priloha_c_3_k_zakonu_c_108_2024_z_z`,
  // `…priloha_ii_k_vyhlasce_…`, `…priloha_a`, `…priloha-1`, and for an act's
  // one annex `…priloha_k_zakonu_c_106_2024_z_z`. The first pattern that
  // matches decides; the last names an annex whose number the id omits.
  annexAnchors: [
    /^(?:prilohy|predpis)\.priloha-priloha_(?:k|ku|vyhlasky|vyhlasce|zakona|zakonu|nariadenia|nariadeniu|opatrenia|opatreniu)_[^.]*$/u,
    /^(?:prilohy|predpis)\.priloha-priloha_(?:c_)?(?<designator>[0-9]+[a-z]{0,2}|[a-z]|[ivx]+)(?:_[^.]*)?$/u,
    /^(?:prilohy|predpis)\.priloha-(?<designator>[0-9]+[a-z]{0,2})$/u,
    /^(?:prilohy|predpis)\.priloha-[^.]+$/u,
  ],
} as const satisfies StatuteAnchorScheme;

const MAGYAR_KOZLONY_KINDS = {
  section: "sz",
  article: "cikk",
  subsection: "bek",
  letter: "pont",
  point: "alpont",
} as const satisfies StatuteAnchorKinds;

/**
 * Magyar Közlöny (Hungary): `sz_10-bek_2`, `sz_6:519-bek_1-pont_b-alpont_ba`,
 * `sz_25/G`, `cikk_IV-bek_1`. A `pont` is a lettered point (`a)`) or a
 * numbered one (`1.`), and an `alpont` sits in a point (`aa)`). A repeated
 * anchor in one act carries `~2`. Wording printed with no number of its own,
 * such as the text that closes a list, is filed under the unit it belongs to
 * by its ordinal there (`sz_9-szoveg_1`). An annex is `mell_1`, an act's one
 * unnumbered annex a bare `mell`, and everything in an annex is filed under
 * it (`mell_1-szoveg_1`).
 */
export const MAGYAR_KOZLONY_ANCHORS = {
  type: "listed",
  kinds: MAGYAR_KOZLONY_KINDS,
  kindSeparator: "_",
  listKinds: {
    [MAGYAR_KOZLONY_KINDS.letter]: 1,
    [MAGYAR_KOZLONY_KINDS.point]: 2,
  },
  restatementSuffix: /~\d+$/u,
  segmentSeparator: "-",
  unnumberedAnchor: /^szoveg_\d+$/u,
  unnumberedSegment: /^szoveg_\d+$/u,
  annexAnchors: [/^mell_(?<designator>[^-]+)$/u, /^mell$/u],
} as const satisfies StatuteAnchorScheme;

/**
 * The prefix a segment of `level` opens with (`pism_`, `pismeno-`): its
 * kind and the kind separator. A value follows it.
 */
export const statuteAnchorKindPrefix = (
  scheme: ListedAnchorScheme,
  level: StatuteAnchorLevel,
): string => `${scheme.kinds[level]}${scheme.kindSeparator}`;

/**
 * The EU: the citation identity minted for an EU provision
 * (`art_5-par_1-pt_a-num_1`), since EUR-Lex links stop at the article.
 */
export const EU_CITATION_ANCHORS = {
  type: "path",
  reason:
    "EU acts open at EUR-Lex, not in the statute reader; only citations name EU subdivisions.",
  segmentSeparator: "-",
} as const satisfies StatuteAnchorScheme;

/** The US Code: `s1983/a/1`, where a section number may carry `-` (`s2000e-2`). */
export const US_CODE_ANCHORS = {
  type: "path",
  reason:
    "US Code anchors (`s1983/a/1`) are positional and no stored consolidation sets their depths.",
  segmentSeparator: "/",
} as const satisfies StatuteAnchorScheme;

/**
 * A statute's blocks, or a run of them, with the scheme its publisher's
 * anchors are read in: every reading of a block's path takes both.
 */
export type StatuteBlocks<TBlock extends { anchorId: string }> = {
  blocks: readonly TBlock[];
  scheme: StatuteAnchorScheme;
};

/** A publisher whose anchors are read whole. */
export const wholeStatuteAnchors = (reason: string) =>
  ({ type: "whole", reason }) as const satisfies StatuteAnchorScheme;

/**
 * Whether a scheme's anchors nest, and on which separator: a flat scheme is
 * a declared decision that every anchor is read whole.
 */
export type StatuteAnchorNesting =
  { type: "nested"; separator: string } | { type: "flat" };

/** How a scheme's anchors nest. */
export const statuteAnchorNesting = (
  scheme: StatuteAnchorScheme,
): StatuteAnchorNesting => {
  switch (scheme.type) {
    case "listed":
    case "path":
      return { type: "nested", separator: scheme.segmentSeparator };
    case "whole":
      return { type: "flat" };
    default:
      scheme satisfies never;
      return panic("Unhandled statute anchor scheme");
  }
};

type AnchorWithinOptions = { ancestor: string; anchor: string };

/** A table's owned anchor; publisher subdivision kinds use their scheme. */
const PARSER_CHILD_SUFFIX = /^-table_\d+(?:$|[.\-/])/u;

/**
 * Whether `anchor` sits under `ancestor`: it continues the ancestor's path by
 * at least one more publisher segment or a parser-derived child suffix such as
 * `-table_1`. The boundary is part of the test, or `odst_2` would own
 * `odst_20`; a restated `pism_c~2` continues no path, so it is never a child
 * of `pism_c`.
 */
export const anchorWithin = (
  scheme: StatuteAnchorScheme,
  { ancestor, anchor }: AnchorWithinOptions,
): boolean => {
  const nesting = statuteAnchorNesting(scheme);
  if (nesting.type !== "nested") {
    return false;
  }
  const continuation = anchor.slice(ancestor.length);
  return (
    anchor.startsWith(`${ancestor}${nesting.separator}`) ||
    (anchor.startsWith(ancestor) && PARSER_CHILD_SUFFIX.test(continuation))
  );
};

type AnchorContinuesSubsectionOptions = { anchor: string; subsection: string };

/**
 * Whether `anchor` is unnumbered wording that a block anchored `subsection`
 * carries on into, when the publisher's path does not say so. e-Sbírka files
 * the alternatives and the closing line of `(1)` under bare `frag_…` anchors,
 * so they read as belonging to nothing, though they are that paragraph's own
 * text and often its penalty. Only a subsection continues this way: a closing
 * line after letters closes the paragraph that opened them, not the last
 * letter, as Slov-Lex's `odsek-1.text2` states outright.
 */
export const anchorContinuesSubsection = (
  scheme: StatuteAnchorScheme,
  { anchor, subsection }: AnchorContinuesSubsectionOptions,
): boolean => {
  if (scheme.type !== "listed" || scheme.unnumberedAnchor === null) {
    return false;
  }
  const innermost = subsection.split(scheme.segmentSeparator).at(-1);
  return (
    innermost !== undefined &&
    innermost.startsWith(statuteAnchorKindPrefix(scheme, "subsection")) &&
    scheme.unnumberedAnchor.test(anchor)
  );
};

type AnchorEndsWithPathOptions = { anchor: string; tail: string };

/**
 * Whether `anchor` ends in the whole segments `tail` names: a citation states
 * the local provision id (`cl_7`) where the publisher files it under a
 * container (`prilohy-cl_7`). Equal anchors are not a tail of each other.
 */
export const anchorEndsWithPath = (
  scheme: StatuteAnchorScheme,
  { anchor, tail }: AnchorEndsWithPathOptions,
): boolean => {
  const nesting = statuteAnchorNesting(scheme);
  return (
    nesting.type === "nested" && anchor.endsWith(`${nesting.separator}${tail}`)
  );
};

type ListSegment = { kind: string; value: string };

/** One anchor segment (`pism_a`) as the list item it names, if it names one. */
const listSegment = (
  scheme: ListedAnchorScheme,
  segment: string,
): ListSegment | null => {
  const separator = segment.indexOf(scheme.kindSeparator);
  if (separator <= 0) {
    return null;
  }
  const kind = segment.slice(0, separator);
  if (!Object.hasOwn(scheme.listKinds, kind)) {
    return null;
  }
  const raw = segment.slice(separator + scheme.kindSeparator.length);
  const value =
    scheme.restatementSuffix === null
      ? raw
      : raw.replace(scheme.restatementSuffix, "");
  return value === "" ? null : { kind, value };
};

/** The list items an anchor's path runs through, outermost first. */
const listSegments = (
  scheme: ListedAnchorScheme,
  anchor: string,
): ListSegment[] => {
  const segments: ListSegment[] = [];
  for (const raw of anchor.split(scheme.segmentSeparator)) {
    const segment = listSegment(scheme, raw);
    if (segment !== null) {
      segments.push(segment);
    }
  }
  return segments;
};

/** The deepest indent the reader draws; a deeper item sits at it. */
const MAX_LIST_DEPTH = 4 satisfies ParagraphListDepth;

const listDepthOf = (depth: number): ParagraphListDepth => {
  const capped = Math.min(depth, MAX_LIST_DEPTH);
  switch (capped) {
    case 1:
    case 2:
    case 3:
    case 4:
      return capped;
    default:
      return panic(`A list depth below 1: ${String(depth)}`);
  }
};

/**
 * How deep the list item an anchor names sits: each item at least as deep as
 * its kind and one level under the item it is nested in, and whatever an
 * item owns (`pism_a-table_1`) as deep as the item. Null for an anchor in no
 * list, such as the paragraph whose lead-in the items continue, and for every
 * anchor of a scheme that names no lists.
 */
export const anchorListDepth = (
  scheme: StatuteAnchorScheme,
  anchor: string,
): ParagraphListDepth | null => {
  if (scheme.type !== "listed") {
    return null;
  }
  let depth = 0;
  for (const { kind } of listSegments(scheme, anchor)) {
    const floor =
      scheme.listKinds[kind] ?? panic(`List kind ${kind} has no depth`);
    depth = Math.max(floor, depth + 1);
  }
  return depth === 0 ? null : listDepthOf(depth);
};

/**
 * The designator value of the list item an anchor ends in (`a` for
 * `par_2-odst_1-pism_a`), or null when its last segment is no list item.
 */
export const anchorListDesignator = (
  scheme: StatuteAnchorScheme,
  anchor: string,
): string | null => {
  if (scheme.type !== "listed") {
    return null;
  }
  const innermost = anchor.split(scheme.segmentSeparator).at(-1);
  return innermost === undefined
    ? null
    : (listSegment(scheme, innermost)?.value ?? null);
};

/**
 * Whether a block's anchor is wording that files under no path at all: a
 * bare `frag_…` (or its table, `frag_…-table`), as e-Sbírka rows parsed
 * before such wording was filed under its parent carry it. Such an anchor
 * states no owner; only where it stands says which unit it belongs to.
 */
export const unfiledAnchor = (
  scheme: StatuteAnchorScheme,
  anchor: string,
): boolean => {
  if (scheme.type !== "listed" || scheme.unnumberedAnchor === null) {
    return false;
  }
  const first = anchor.split(scheme.segmentSeparator).at(0) ?? anchor;
  return scheme.unnumberedAnchor.test(first);
};

/** A segment the parser derives for a table a row holds (`-table`, `-table_1`, `-table-text`). */
const PARSER_DERIVED_SEGMENT = /^(?:table(?:_\d+)?|text)$/u;

/**
 * The unit unnumbered wording is filed under: `par_5-pism_e` for
 * `par_5-pism_e-frag_6070235`, `odsek-1` for `odsek-1.text2`. Null for a
 * numbered unit's own block, for unfiled wording, and for a scheme that
 * names no unnumbered wording.
 */
export const wordingOwnerAnchor = (
  scheme: StatuteAnchorScheme,
  anchor: string,
): string | null => {
  if (scheme.type !== "listed") {
    return null;
  }
  const segments = anchor.split(scheme.segmentSeparator);
  let end = segments.length;
  let unnumbered = false;
  while (end > 0) {
    const segment = segments[end - 1] ?? "";
    if (scheme.unnumberedSegment.test(segment)) {
      unnumbered = true;
    } else if (!PARSER_DERIVED_SEGMENT.test(segment)) {
      break;
    }
    end -= 1;
  }
  return unnumbered && end > 0
    ? segments.slice(0, end).join(scheme.segmentSeparator)
    : null;
};

type ProvisionAncestorsOptions = { anchor: string; provision: string };

/**
 * The units a subdivision is nested in, from its provision inward, without
 * the subdivision itself: `par_5` and `par_5-odst_1` for
 * `par_5-odst_1-pism_e`. Empty where the scheme does not nest or the anchor
 * is not under the provision.
 */
export const provisionAncestorAnchors = (
  scheme: StatuteAnchorScheme,
  { anchor, provision }: ProvisionAncestorsOptions,
): string[] => {
  const nesting = statuteAnchorNesting(scheme);
  if (
    nesting.type !== "nested" ||
    !anchor.startsWith(`${provision}${nesting.separator}`)
  ) {
    return [];
  }
  const ancestors = [provision];
  const rest = anchor
    .slice(provision.length + nesting.separator.length)
    .split(nesting.separator);
  let path = provision;
  for (const segment of rest.slice(0, -1)) {
    path = `${path}${nesting.separator}${segment}`;
    ancestors.push(path);
  }
  return ancestors;
};

/**
 * The designator of the annex a heading anchor names (`3` for `pril_3`),
 * `""` for an act's one unnumbered annex, or null when the anchor names no
 * annex in the scheme's grammar.
 */
export const annexDesignator = (
  scheme: StatuteAnchorScheme,
  anchor: string,
): string | null => {
  if (scheme.type !== "listed") {
    return null;
  }
  for (const pattern of scheme.annexAnchors) {
    const match = pattern.exec(anchor);
    if (match !== null) {
      return (match.groups?.["designator"] ?? "").toLowerCase();
    }
  }
  return null;
};

/**
 * The annex a caller's spelling names, whatever grammar it was written in:
 * `priloha_3`, `příloha č. 3`, `Příloha 3`, `pril_3`, `annex-3`,
 * `prilohy.priloha-3`, `1. melléklet`, `melléklet 1`, or a bare
 * `priloha` or `melléklet` for an act's one annex. Returns the designator
 * lower-cased, or null when the spelling names no annex. A designator that
 * the `č.`/`no.` prefix could also have eaten (`pril_c`) is read as the
 * designator.
 */
export const requestedAnnexDesignator = (requested: string): string | null => {
  const folded = stripDiacritics(requested).toLowerCase().trim();
  // Hungarian prints the number first: `1. melléklet`.
  const numberFirst =
    /^(?<designator>[0-9a-z]+(?:[/:][0-9a-z]+)?)(?:\.[ ._-]*|[ ._-]+)melleklet$/u.exec(
      folded,
    )?.groups?.["designator"];
  if (numberFirst !== undefined) {
    return numberFirst;
  }
  const match =
    /^(?:prilohy[ ._-]*)?(?:priloha|pril|melleklet|annex|appendix)(?<prefix>[ ._-]*(?:c|cislo|no|nr)\.?)?[ ._-]*(?<designator>[0-9a-z]+(?:[/:][0-9a-z]+)?)?$/u.exec(
      folded,
    );
  if (match === null) {
    return null;
  }
  const designator = match.groups?.["designator"];
  if (designator !== undefined) {
    return designator;
  }
  const prefix = match.groups?.["prefix"]?.replace(/[ ._-]/gu, "");
  return prefix === "c" ? "c" : "";
};
