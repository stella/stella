// What a Word template means: which of its styles and list levels stand for
// an article heading, a clause, a letter item; which of its blocks are kept
// around a document (a letterhead, a table of contents) and which are sample
// text; which fields must not stay live. Inferred from the template alone,
// by rule, with a confidence per reading, so a person can confirm it once and
// every later document is placed the same way.

import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import type {
  DocxBlock,
  TemplateInspection,
  TemplateLevelIndent,
  TemplateStyle,
} from "@/api/lib/templates/house-style/folio-contract";
import { HOUSE_STYLE_ROLES } from "@/api/lib/templates/house-style/role-proposer";
import type { HouseStyleRole } from "@/api/lib/templates/house-style/role-proposer";

const ROLE_EVIDENCE = ["styleName", "sample", "listLevel", "fallback"] as const;

type RoleEvidence = (typeof ROLE_EVIDENCE)[number];

/** The list level that numbers a role, with the format it prints in. */
export type ProfileListLevel = {
  numId: number;
  ilvl: number;
  abstractNumId: number;
  numFmt: string;
  lvlText: string;
  start: number;
  /** The indent the level gives its paragraphs. */
  indent: TemplateLevelIndent;
};

export type ProfileRoleTarget = {
  styleId: string;
  /** The paragraph alignment the style states; null when it states none. */
  alignment: string | null;
  /** Null for a role the template does not number. */
  numbering: ProfileListLevel | null;
  confidence: number;
  evidence: RoleEvidence[];
};

/** How a heading and its title share a paragraph in the template's sample. */
type HeadingJoin = "sameLine" | "lineBreak";

/**
 * Something in the template a firm may want to mend at its source. The
 * output is right either way; the finding says what the template itself
 * does when a document is made from it by hand.
 *
 * `numberDrawnAsPicture`, `textDrawnAsPicture`: the run properties of a
 * list level, or of a style or the document defaults, carry a 3-D scene
 * that shows nothing. A word processor draws such text as a picture: in an
 * exported document the number or the text cannot be found, copied or read
 * aloud. Clearing the 3-D format on the level or style mends it.
 */
export type TemplateHealthFinding =
  | { kind: "numberDrawnAsPicture"; abstractNumId: number; ilvl: number }
  | { kind: "textDrawnAsPicture"; styleId: string | null };

export type TemplateProfile = {
  version: 1;
  templateSha256: string;
  /** `parallelColumns` when the sample body runs in a table of two texts
   *  side by side; such a template is read, but not yet filled by column. */
  layout: "flow" | "parallelColumns";
  /** Total on purpose: a role the template has nothing for is `null`. */
  roles: Record<HouseStyleRole, ProfileRoleTarget | null>;
  /** Levels of the outline list no style uses, below the roles' own. A
   *  format the roles' levels do not print is patched onto one of them. */
  spareLevels: ProfileListLevel[];
  /** Levels of the template's other lists that no style uses. A bullet
   *  counts nothing, so its mark need not stand in the outline list: it is
   *  patched onto one of these first, and the outline's spare levels stay
   *  for formats that count. Absent from a profile inferred before them. */
  markLevels?: ProfileListLevel[];
  /** Top-level template blocks by what becomes of them. */
  regions: {
    /** Kept in front of the document: a letterhead, a memo header. */
    keepBefore: string[];
    /** The table of contents field with its caption, kept whole. Empty
     *  when the template has none, or when its field shows entries of the
     *  sample text: those cite headings that are dropped with the sample. */
    contents: string[];
    /** Sample text, dropped. */
    filler: string[];
  };
  /** Sample blocks a document's own parties and signatures stand in for. */
  slots: {
    party: { blockIds: string[] } | null;
    signature: { blockIds: string[] } | null;
  };
  headings: { article: HeadingJoin; annex: HeadingJoin };
  fields: {
    /** Kinds replaced by their shown text: they prompt, or change on open. */
    freezeKinds: string[];
    /** Kinds that stay fields: page numbers, the file name, the contents. */
    liveKinds: string[];
  };
  /** Placeholder strings of the sample; none may reach an output. */
  fillerStrings: string[];
  /** How the template numbers an annex heading; null when it shows none. */
  annex: { numbering: "list" | "field" | "typed" } | null;
  /** The alignment of the template's default paragraph style, which a
   *  paragraph placed without a style takes; null when it states none.
   *  Absent from a profile inferred before it was read. */
  defaultAlignment?: string | null;
  /** What the template could have mended at its source. Absent from a
   *  profile inferred before the template was read for it. */
  health?: TemplateHealthFinding[];
  confidence: number;
};

const VOLATILE_FIELD_KINDS: ReadonlySet<string> = new Set([
  "FILLIN",
  "ASK",
  "DATE",
  "TIME",
]);
const CONTENTS_FIELD = "TOC";
/** The page reference each entry of a filled table of contents carries. */
const CONTENTS_ENTRY_FIELD = "PAGEREF";
const ANNEX_NUMBER_FIELDS: ReadonlySet<string> = new Set([
  "AUTONUM",
  "AUTONUMLGL",
  "SEQ",
]);

const NAME = {
  heading:
    /nadpis|článek|clanek|\bčl\b|article|heading|überschrift|artikel|\btitle\b/iu,
  paragraph: /odstavec|\bodst\b|paragraph|clause|absatz|abschnitt/iu,
  party: /smluvní stran|smluvni stran|\bpart(?:y|ies)\b|partei/iu,
  recital: /preambul|recital|präambel|whereas/iu,
  signature: /podpis|signature|unterschrift/iu,
  title: /centred|centered|\btitle\b|název|nazev|titul|\btitel\b/iu,
  continuation: /odsazen|indent|einzug|continu/iu,
  body: /základní|zakladni|body text|standard|fließtext|textkörper/iu,
  annexList: /seznam příloh|annex list|list of annexes|anlagenverzeichnis/iu,
  contents: /^(?:toc|obsah|verzeichnis|inhaltsverzeichnis)\b/iu,
} as const;

const ANNEX_SAMPLE =
  /^(?:příloha|annexure|annex|schedule|appendix|exhibit|anlage|anhang)\b/iu;
const PARTY_SAMPLE =
  /sídl|IČO?\b|zapsan|zastoupen|registered|represented|company (?:no|number)|mit sitz|vertreten|handelsregister/iu;
const SIGNATURE_SAMPLE = /[.…_]{6,}/u;
const BRACKET_PLACEHOLDER = /\[[^\]\n]{1,80}\]/u;
const GENERIC_FILLER = [
  "Lorem ipsum",
  "Click or tap here",
  "Klikněte nebo klepněte sem",
  "Klicken oder tippen Sie hier",
] as const;
/** Literal text of a level beyond counters and their delimiters. */
const LEVEL_WORDS = /[^\s\d.()[\]\-–—/:,;%]/u;
/** A line that heads a table of contents and says nothing else. */
const CONTENTS_CAPTION =
  /^(?:obsah|contents|table of contents|inhalt|inhaltsverzeichnis)[ \u00A0]*:?$/iu;
/** What a doubt about the template takes off the profile's confidence. */
const UNCERTAIN_SHARE = 0.5;

const CONFIDENCE = {
  nameAndSample: 0.95,
  nameAndLevel: 0.9,
  name: 0.8,
  sample: 0.75,
  level: 0.7,
  fallback: 0.3,
} as const;

const NO_BLOCKS: readonly DocxBlock[] = [];

type StyleFacts = {
  style: TemplateStyle;
  level: ProfileListLevel | null;
  /** Sample paragraphs written in the style, in document order. */
  samples: readonly DocxBlock[];
};

/** Whether a list level prints a label: a number or a mark. A level in the
 *  format `none`, or with an empty level text, counts and shows nothing. */
const printsLabel = ({
  numFmt,
  lvlText,
}: Pick<ProfileListLevel, "numFmt" | "lvlText">): boolean =>
  numFmt !== "none" && lvlText.trim() !== "";

const target = (
  { style, level }: StyleFacts,
  confidence: number,
  ...evidence: RoleEvidence[]
): ProfileRoleTarget => ({
  styleId: style.styleId,
  alignment: style.alignment,
  // A level that prints nothing numbers nothing: the style keeps its role
  // and its place in the outline, without a list.
  numbering: level !== null && printsLabel(level) ? level : null,
  confidence,
  evidence,
});

const unnumbered = (role: ProfileRoleTarget): ProfileRoleTarget => ({
  ...role,
  numbering: null,
});

const nameOf = ({ style }: StyleFacts): string => style.name ?? style.styleId;

const isLetterFormat = (numFmt: string): boolean =>
  numFmt === "lowerLetter" || numFmt === "upperLetter";

const isRomanFormat = (numFmt: string): boolean =>
  numFmt === "lowerRoman" || numFmt === "upperRoman";

const collectStyleFacts = ({
  styles,
  numbering,
  blocks,
}: TemplateInspection): StyleFacts[] => {
  const abstractByNum = new Map(
    numbering.nums.map(({ numId, abstractNumId }) => [numId, abstractNumId]),
  );
  const levelsByAbstract = new Map(
    numbering.abstractNums.map(({ abstractNumId, levels }) => [
      abstractNumId,
      levels,
    ]),
  );
  const levelOf = ({ numPr }: TemplateStyle): ProfileListLevel | null => {
    if (numPr === null) {
      return null;
    }
    const abstractNumId = abstractByNum.get(numPr.numId);
    const level =
      abstractNumId === undefined
        ? undefined
        : levelsByAbstract
            .get(abstractNumId)
            ?.find(({ ilvl }) => ilvl === numPr.ilvl);
    if (abstractNumId === undefined || level === undefined) {
      return null;
    }
    return {
      numId: numPr.numId,
      ilvl: numPr.ilvl,
      abstractNumId,
      numFmt: level.numFmt,
      lvlText: level.lvlText,
      start: level.start,
      indent: level.indent,
    };
  };
  const samplesByStyle = Map.groupBy(
    blocks.filter(
      ({ kind, styleId }) => kind === "paragraph" && styleId !== null,
    ),
    ({ styleId }) => styleId ?? "",
  );
  return styles
    .filter(({ type }) => type === "paragraph")
    .map((style) => ({
      style,
      level: levelOf(style),
      // A style the sample text does not use has no samples.
      samples: samplesByStyle.get(style.styleId) ?? NO_BLOCKS,
    }));
};

/** Sample paragraphs counted when two outlines are ranked. */
const SAMPLES_RANKED_MAX = 999;

/**
 * The template's outline: of the lists with styles on two levels or more,
 * the one its sample text is written in. A template often carries further
 * lists with as many levels (schedules, a second language) that its sample
 * body never uses. Among lists used alike, the one with more levels, then
 * the one with more sample paragraphs.
 */
const mainListOf = (facts: readonly StyleFacts[]): StyleFacts[] => {
  const byAbstract = Map.groupBy(
    facts.filter(({ level }) => level !== null),
    ({ level }) => level?.abstractNumId ?? -1,
  );
  let best: StyleFacts[] = [];
  let bestScore = 0;
  for (const group of byAbstract.values()) {
    const levels = new Set(group.map(({ level }) => level?.ilvl)).size;
    const samples = group.reduce((sum, fact) => sum + fact.samples.length, 0);
    const score =
      (samples > 0 ? 1_000_000 : 0) +
      levels * 1000 +
      Math.min(samples, SAMPLES_RANKED_MAX);
    if (levels >= 2 && score > bestScore) {
      best = group;
      bestScore = score;
    }
  }
  // By level; within a level the style the sample text uses comes first.
  return best.toSorted(
    (left, right) =>
      (left.level?.ilvl ?? 0) - (right.level?.ilvl ?? 0) ||
      right.samples.length - left.samples.length,
  );
};

type OutlineRoles = Partial<
  Record<
    "articleHeading" | "clause1" | "clause2" | "clause3" | "letter" | "roman",
    ProfileRoleTarget
  >
>;

/**
 * The clause depths among counted levels: levels in a row, the first one
 * directly under the heading. `1.1.` stands directly under `1.`, `1.1.1.`
 * directly under that; a counted level further down the list, past a
 * lettered or roman one, is not the next clause depth. `printing` are the
 * levels of the outline that print a label, in order: a level that prints
 * nothing does not part two depths.
 */
const clauseChain = (
  counted: readonly StyleFacts[],
  printing: readonly number[],
  heading: StyleFacts | null,
): StyleFacts[] => {
  const positionOf = (fact: StyleFacts | undefined): number | undefined =>
    fact?.level === null || fact === undefined
      ? undefined
      : printing.indexOf(fact.level.ilvl);
  const chain: StyleFacts[] = [];
  let above = heading === null ? undefined : positionOf(heading);
  for (const fact of counted) {
    const position = positionOf(fact);
    if (above !== undefined && position !== above + 1) {
      break;
    }
    chain.push(fact);
    above = position;
  }
  return chain;
};

/** Sorts the outline's levels: the lettered and roman ones to their roles,
 *  a top level without a label to the heading, the counted ones in order. */
const sortOutline = (
  outline: readonly StyleFacts[],
): { roles: OutlineRoles; counted: StyleFacts[]; printing: number[] } => {
  const roles: OutlineRoles = {};
  const counted: StyleFacts[] = [];
  const printing = new Set<number>();
  for (const fact of outline) {
    const numFmt = fact.level?.numFmt ?? "";
    const top = fact.level?.ilvl === 0;
    if (fact.level !== null && !printsLabel(fact.level)) {
      // The top level of the outline is its heading also when it prints
      // no number; a level below that prints nothing is no depth of it.
      if (top) {
        roles.articleHeading ??= target(fact, CONFIDENCE.level, "listLevel");
      }
      continue;
    }
    if (fact.level !== null) {
      printing.add(fact.level.ilvl);
    }
    if (isLetterFormat(numFmt) && !top) {
      roles.letter ??= target(fact, CONFIDENCE.nameAndLevel, "listLevel");
    } else if (isRomanFormat(numFmt) && !top) {
      roles.roman ??= target(fact, CONFIDENCE.nameAndLevel, "listLevel");
    } else if (
      (numFmt === "decimal" || top) &&
      // Two styles on one level are one level of the outline: the first,
      // which is the one the sample text uses, stands for it.
      !counted.some(({ level }) => level?.ilvl === fact.level?.ilvl)
    ) {
      counted.push(fact);
    }
  }
  return {
    roles,
    counted,
    printing: [...printing].toSorted((left, right) => left - right),
  };
};

/** Reads the outline: counted levels are the heading and the clauses under
 *  it, the lettered level the letter items, the roman level below the
 *  points. */
const readOutline = (outline: readonly StyleFacts[]): OutlineRoles => {
  const { roles, counted, printing } = sortOutline(outline);
  const first = counted.at(0);
  if (first === undefined) {
    return roles;
  }
  const name = nameOf(first);
  const words = LEVEL_WORDS.test(first.level?.lvlText ?? "");
  // A level named a paragraph and printing a bare number is a clause; the
  // template then heads its sections outside this list, or not at all.
  const headsArticles =
    roles.articleHeading === undefined &&
    (words || NAME.heading.test(name) || !NAME.paragraph.test(name));
  const clauses = headsArticles ? counted.slice(1) : counted;
  if (headsArticles) {
    roles.articleHeading = target(
      first,
      words || NAME.heading.test(name)
        ? CONFIDENCE.nameAndLevel
        : CONFIDENCE.level,
      ...(NAME.heading.test(name) ? (["styleName"] as const) : []),
      "listLevel",
    );
  }
  const [first1, first2, first3] = clauseChain(
    clauses,
    printing,
    headsArticles ? first : null,
  ).map((fact) => target(fact, CONFIDENCE.nameAndLevel, "listLevel"));
  if (first1 !== undefined) {
    roles.clause1 = first1;
  }
  if (first2 !== undefined) {
    roles.clause2 = first2;
  }
  if (first3 !== undefined) {
    roles.clause3 = first3;
  }
  return roles;
};

const byName = (
  facts: readonly StyleFacts[],
  pattern: RegExp,
  accept: (fact: StyleFacts) => boolean = () => true,
): StyleFacts | undefined => {
  const named = facts.filter(
    (fact) => pattern.test(nameOf(fact)) && accept(fact),
  );
  // A style the sample text uses is the one the template means.
  return named.find(({ samples }) => samples.length > 0) ?? named.at(0);
};

const bySample = (
  facts: readonly StyleFacts[],
  pattern: RegExp,
  accept: (fact: StyleFacts) => boolean = () => true,
): StyleFacts | undefined => {
  let best: StyleFacts | undefined;
  let bestCount = 0;
  for (const fact of facts) {
    const count = accept(fact)
      ? fact.samples.filter(({ text }) => pattern.test(text)).length
      : 0;
    if (count > bestCount) {
      best = fact;
      bestCount = count;
    }
  }
  return best;
};

const isUnnumbered = ({ level }: StyleFacts): boolean => level === null;

const inferRoles = (
  facts: readonly StyleFacts[],
  topLevel: readonly DocxBlock[],
): TemplateProfile["roles"] => {
  const outline = mainListOf(facts);
  const inOutline = new Set(outline.map(({ style }) => style.styleId));
  const outside = facts.filter(({ style }) => !inOutline.has(style.styleId));
  const fromOutline = readOutline(outline);

  const namedHeading = byName(
    outside,
    NAME.heading,
    ({ level, style }) => level !== null || style.outlineLvl !== null,
  );
  const articleHeading =
    fromOutline.articleHeading ??
    (namedHeading === undefined
      ? null
      : target(namedHeading, CONFIDENCE.name, "styleName"));

  const namedRecital = byName(outside, NAME.recital, ({ level }) =>
    isLetterFormat(level?.numFmt ?? ""),
  );
  const recital =
    namedRecital === undefined
      ? null
      : target(namedRecital, CONFIDENCE.nameAndLevel, "styleName", "listLevel");

  const partySample = bySample(outside, PARTY_SAMPLE, isUnnumbered);
  const partyNamed = byName(outside, NAME.party);
  let party: ProfileRoleTarget | null = null;
  if (partySample !== undefined) {
    party = target(partySample, CONFIDENCE.sample, "sample");
  } else if (partyNamed !== undefined) {
    // The numbered style heads a party; its details carry no number.
    party = unnumbered(target(partyNamed, CONFIDENCE.name, "styleName"));
  }

  const signatureNamed = byName(outside, NAME.signature, isUnnumbered);
  const signatureSample = bySample(outside, SIGNATURE_SAMPLE, isUnnumbered);
  let signature: ProfileRoleTarget | null = null;
  if (signatureNamed !== undefined) {
    signature =
      signatureNamed === signatureSample
        ? target(
            signatureNamed,
            CONFIDENCE.nameAndSample,
            "styleName",
            "sample",
          )
        : target(signatureNamed, CONFIDENCE.name, "styleName");
  }

  const firstText = topLevel.find(
    ({ kind, text }) => kind === "paragraph" && text.trim() !== "",
  );
  const titleNamed = byName(outside, NAME.title, isUnnumbered);
  const titleFirst = outside.find(
    ({ style, level }) =>
      level === null && style.styleId === firstText?.styleId,
  );
  let title: ProfileRoleTarget | null = null;
  if (titleNamed !== undefined) {
    title =
      titleNamed === titleFirst
        ? target(titleNamed, CONFIDENCE.nameAndSample, "styleName", "sample")
        : target(titleNamed, CONFIDENCE.name, "styleName");
  }

  const continuationNamed = byName(outside, NAME.continuation, isUnnumbered);
  const bodyNamed = byName(outside, NAME.body, isUnnumbered);
  const defaultStyle = facts.find(({ style }) => style.isDefault);
  let body: ProfileRoleTarget | null = null;
  if (bodyNamed !== undefined) {
    body = target(bodyNamed, CONFIDENCE.name, "styleName");
  } else if (defaultStyle !== undefined) {
    body = unnumbered(target(defaultStyle, CONFIDENCE.fallback, "fallback"));
  }

  // A heading style may carry a bullet list too; a bullet is body text.
  const bulleted =
    facts.find(
      ({ level, style, samples }) =>
        level?.numFmt === "bullet" &&
        style.outlineLvl === null &&
        samples.length > 0,
    ) ??
    facts.find(
      ({ level, style }) =>
        level?.numFmt === "bullet" && style.outlineLvl === null,
    );
  const annexSample = bySample(outside, ANNEX_SAMPLE);
  const annexListNamed = byName(outside, NAME.annexList);

  return {
    title,
    party,
    recital,
    articleHeading,
    clause1: fromOutline.clause1 ?? null,
    clause2: fromOutline.clause2 ?? null,
    clause3: fromOutline.clause3 ?? null,
    letter: fromOutline.letter ?? null,
    roman: fromOutline.roman ?? null,
    bullet:
      bulleted === undefined
        ? null
        : target(bulleted, CONFIDENCE.level, "listLevel"),
    continuation:
      continuationNamed === undefined
        ? null
        : target(continuationNamed, CONFIDENCE.name, "styleName"),
    signature,
    annexList:
      annexListNamed === undefined
        ? null
        : target(annexListNamed, CONFIDENCE.name, "styleName"),
    annexHeading:
      annexSample === undefined
        ? null
        : unnumbered(target(annexSample, CONFIDENCE.sample, "sample")),
    body,
  };
};

const joinOf = (samples: readonly DocxBlock[]): HeadingJoin =>
  samples.some(({ text }) => text.trim().includes("\n"))
    ? "lineBreak"
    : "sameLine";

type Structure = {
  topLevel: DocxBlock[];
  nestedOf: Map<string, DocxBlock[]>;
};

const readStructure = (blocks: readonly DocxBlock[]): Structure => {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const nestedOf = new Map<string, DocxBlock[]>();
  const nestedIds = new Set<string>();
  for (const block of blocks) {
    if (block.cells === undefined) {
      continue;
    }
    const inside = block.cells.flatMap(({ blockIds }) =>
      blockIds.flatMap((id) => {
        const inner = byId.get(id);
        return inner === undefined ? [] : [inner];
      }),
    );
    nestedOf.set(block.id, inside);
    for (const { id } of inside) {
      nestedIds.add(id);
    }
  }
  return {
    topLevel: blocks.filter(({ id }) => !nestedIds.has(id)),
    nestedOf,
  };
};

type RegionOptions = {
  inspection: TemplateInspection;
  structure: Structure;
  roles: TemplateProfile["roles"];
};

const inferRegions = ({
  inspection: { fields },
  structure: { topLevel, nestedOf },
  roles,
}: RegionOptions): Pick<TemplateProfile, "regions" | "slots"> => {
  const order = topLevel.map(({ id }) => id);
  const contents: string[] = [];
  const contentsField = fields.find(
    ({ kind, blockId }) => kind === CONTENTS_FIELD && blockId !== undefined,
  );
  if (contentsField?.blockId !== undefined) {
    const from = order.indexOf(contentsField.blockId);
    const to = order.indexOf(contentsField.endBlockId ?? contentsField.blockId);
    const span = new Set(order.slice(from, to + 1));
    const showsEntries = fields.some(
      ({ kind, blockId }) =>
        kind === CONTENTS_ENTRY_FIELD &&
        blockId !== undefined &&
        span.has(blockId),
    );
    if (from !== -1 && to >= from && !showsEntries) {
      const caption = topLevel[from - 1];
      // The caption above the field belongs to it. A short line that does
      // not name the contents is sample text of something else.
      if (
        caption?.kind === "paragraph" &&
        CONTENTS_CAPTION.test(caption.text.trim())
      ) {
        contents.push(caption.id);
      }
      contents.push(...order.slice(from, to + 1));
    }
  }
  const inContents = new Set(contents);

  const numberedStyles = new Set(
    Object.values(roles).flatMap((role) =>
      role?.numbering ? [role.styleId] : [],
    ),
  );
  const partyStyle = roles.party?.styleId;
  const signatureStyle = roles.signature?.styleId;
  const insideOf = (block: DocxBlock): readonly DocxBlock[] => {
    if (block.kind !== "table") {
      return [block];
    }
    // A table without cells holds nothing.
    return nestedOf.get(block.id) ?? NO_BLOCKS;
  };
  // The sample body starts at the first numbered sample paragraph, alone
  // or in a table, or at the table of contents; what stands before it is
  // front matter.
  const bodyStart = topLevel.findIndex(
    (block) =>
      inContents.has(block.id) ||
      insideOf(block).some(
        ({ label, styleId }) =>
          label !== null && numberedStyles.has(styleId ?? ""),
      ),
  );
  const front = bodyStart === -1 ? topLevel : topLevel.slice(0, bodyStart);
  const isSample = (block: DocxBlock): boolean =>
    insideOf(block).some(
      ({ text, styleId }) =>
        text.search(BRACKET_PLACEHOLDER) !== -1 ||
        (styleId === partyStyle && PARTY_SAMPLE.test(text)),
    );
  // A table in the front matter that is not sample text is a letterhead or
  // a header of label and value cells; it is kept with what stands above
  // it and the objects right below. Front matter without one is a sample
  // title.
  const isFurniture = (block: DocxBlock): boolean =>
    (block.kind === "table" || (block.inlineObjects ?? 0) > 0) &&
    !isSample(block);
  const lastKept = front.findLastIndex(isFurniture);
  const keepBefore = front.some(
    (block) => block.kind === "table" && isFurniture(block),
  )
    ? front
        .slice(0, lastKept + 1)
        .filter(
          (block) =>
            !isSample(block) &&
            (block.kind === "table" ||
              block.text.trim() !== "" ||
              (block.inlineObjects ?? 0) > 0),
        )
        .map(({ id }) => id)
    : [];
  const kept = new Set([...keepBefore, ...contents]);

  /** Every block from the first to the last that matches: one sample. */
  const spanOf = (matches: (block: DocxBlock) => boolean): string[] => {
    const first = topLevel.findIndex(matches);
    const last = topLevel.findLastIndex(matches);
    return first === -1
      ? []
      : topLevel
          .slice(first, last + 1)
          .filter(({ id }) => !kept.has(id))
          .map(({ id }) => id);
  };
  const partyBlocks = spanOf(
    (block) =>
      !kept.has(block.id) &&
      partyStyle !== undefined &&
      insideOf(block).some(
        ({ styleId, text }) =>
          styleId === partyStyle && PARTY_SAMPLE.test(text),
      ),
  );
  const signatureBlocks = spanOf(
    (block) =>
      !kept.has(block.id) &&
      block.kind === "table" &&
      insideOf(block).some(
        ({ styleId, text }) =>
          styleId === signatureStyle || SIGNATURE_SAMPLE.test(text),
      ),
  );

  return {
    regions: {
      keepBefore,
      contents,
      filler: order.filter((id) => !kept.has(id)),
    },
    slots: {
      party: partyBlocks.length === 0 ? null : { blockIds: partyBlocks },
      signature:
        signatureBlocks.length === 0 ? null : { blockIds: signatureBlocks },
    },
  };
};

const inferFillerStrings = (blocks: readonly DocxBlock[]): string[] => {
  const found = new Set<string>();
  for (const { kind, text } of blocks) {
    if (kind !== "paragraph") {
      continue;
    }
    for (const [placeholder] of text.matchAll(
      new RegExp(BRACKET_PLACEHOLDER, "gu"),
    )) {
      found.add(placeholder);
    }
    for (const phrase of GENERIC_FILLER) {
      if (text.includes(phrase)) {
        found.add(phrase);
      }
    }
  }
  return [...found];
};

const STRUCTURAL_ROLES = [
  "articleHeading",
  "clause1",
  "body",
] as const satisfies readonly HouseStyleRole[];

/** A list has nine levels; a template has some lists and some styles. A
 *  template with more findings than this is reported up to here: the
 *  profile stays readable, and so many say the same thing anyway. */
const HEALTH_FINDINGS_MAX = 2000;

/** The template's findings, each once, in the order the template has them. */
const inferHealth = ({
  invisibleEffects = [],
}: TemplateInspection): TemplateHealthFinding[] => {
  const findings = new Map<string, TemplateHealthFinding>();
  for (const { effect, owner } of invisibleEffects) {
    // Of the effects that show nothing only the 3-D scene changes how the
    // text is written out.
    if (effect !== "scene3d") {
      continue;
    }
    if (owner.kind === "level") {
      if (owner.abstractNumId !== null && owner.ilvl !== null) {
        const { abstractNumId, ilvl } = owner;
        findings.set(`level ${String(abstractNumId)} ${String(ilvl)}`, {
          kind: "numberDrawnAsPicture",
          abstractNumId,
          ilvl,
        });
      }
    } else if (owner.kind === "style" || owner.kind === "defaults") {
      const styleId = owner.kind === "style" ? owner.styleId : null;
      findings.set(`style ${styleId ?? ""}`, {
        kind: "textDrawnAsPicture",
        styleId,
      });
    }
  }
  return [...findings.values()].slice(0, HEALTH_FINDINGS_MAX);
};

/**
 * The deeper levels of another list of the template that no style is bound
 * to: none of the roles' lists, and not the outline's.
 */
const inferMarkLevels = (
  inspection: TemplateInspection,
  roles: TemplateProfile["roles"],
  outlineLevel: ProfileListLevel | null,
): ProfileListLevel[] => {
  const numIdByList = new Map(
    inspection.numbering.nums.map(({ numId, abstractNumId }) => [
      abstractNumId,
      numId,
    ]),
  );
  const roleLists = new Set(
    Object.values(roles).flatMap((role) =>
      role?.numbering ? [role.numbering.abstractNumId] : [],
    ),
  );
  const markList = inspection.numbering.abstractNums.find(
    ({ abstractNumId, levels }) =>
      abstractNumId !== outlineLevel?.abstractNumId &&
      !roleLists.has(abstractNumId) &&
      numIdByList.has(abstractNumId) &&
      levels.length > 1 &&
      levels.every(({ ilvl, pStyle }) => ilvl === 0 || pStyle === null),
  );
  const markNumId =
    markList === undefined
      ? undefined
      : numIdByList.get(markList.abstractNumId);
  if (markList === undefined || markNumId === undefined) {
    return [];
  }
  return markList.levels
    .filter(({ ilvl }) => ilvl > 0)
    .map(({ ilvl, numFmt, lvlText, start, indent }) => ({
      numId: markNumId,
      ilvl,
      abstractNumId: markList.abstractNumId,
      numFmt,
      lvlText,
      start,
      indent,
    }));
};

/**
 * Infers a template's profile from its inspection. Deterministic: the same
 * template gives the same profile. Readings carry a confidence and their
 * evidence; a person confirms or corrects them before the profile is stored.
 */
export const inferTemplateProfile = (
  inspection: TemplateInspection,
): TemplateProfile => {
  const facts = collectStyleFacts(inspection);
  const structure = readStructure(inspection.blocks);
  const roles = inferRoles(facts, structure.topLevel);
  const samplesOf = (role: ProfileRoleTarget | null): readonly DocxBlock[] =>
    facts.find(({ style }) => style.styleId === role?.styleId)?.samples ??
    NO_BLOCKS;

  const paragraphs = inspection.blocks.filter(
    ({ kind }) => kind === "paragraph",
  );
  const numberedStyles = new Set(
    Object.values(roles).flatMap((role) =>
      role?.numbering ? [role.styleId] : [],
    ),
  );
  const numberedSamples = paragraphs.some(
    ({ label, styleId }) => label !== null && numberedStyles.has(styleId ?? ""),
  );
  const isNumberedSample = ({ label, styleId }: DocxBlock): boolean =>
    label !== null && numberedStyles.has(styleId ?? "");
  // Two texts side by side: every numbered sample paragraph sits in a table.
  const columnTable =
    numberedSamples && !structure.topLevel.some(isNumberedSample);

  const annexSamples = samplesOf(roles.annexHeading).filter(({ text }) =>
    ANNEX_SAMPLE.test(text),
  );
  const annexSample = annexSamples.at(0);
  let annex: TemplateProfile["annex"] = null;
  if (annexSample !== undefined) {
    const numberedByField = inspection.fields.some(
      ({ kind, blockId }) =>
        ANNEX_NUMBER_FIELDS.has(kind) && blockId === annexSample.id,
    );
    if (annexSample.label !== null) {
      annex = { numbering: "list" };
    } else {
      annex = { numbering: numberedByField ? "field" : "typed" };
    }
  }

  const outlineLevel =
    roles.articleHeading?.numbering ?? roles.clause1?.numbering ?? null;
  const boundLevels = new Set(
    facts.flatMap(({ level }) =>
      level !== null && level.abstractNumId === outlineLevel?.abstractNumId
        ? [level.ilvl]
        : [],
    ),
  );
  const deepest = Math.max(-1, ...boundLevels);
  const outlineList = inspection.numbering.abstractNums.find(
    ({ abstractNumId }) => abstractNumId === outlineLevel?.abstractNumId,
  );
  const spareLevels: ProfileListLevel[] =
    outlineLevel === null || outlineList === undefined
      ? []
      : outlineList.levels
          .filter(({ ilvl, pStyle }) => ilvl > deepest && pStyle === null)
          .map(({ ilvl, numFmt, lvlText, start, indent }) => ({
            numId: outlineLevel.numId,
            ilvl,
            abstractNumId: outlineLevel.abstractNumId,
            numFmt,
            lvlText,
            start,
            indent,
          }));

  const markLevels = inferMarkLevels(inspection, roles, outlineLevel);

  const kinds = [...new Set(inspection.fields.map(({ kind }) => kind))];
  const structural = STRUCTURAL_ROLES.map(
    (role) => roles[role]?.confidence ?? 0,
  );
  return {
    version: 1,
    templateSha256: inspection.sha256,
    layout: columnTable ? "parallelColumns" : "flow",
    roles,
    spareLevels,
    markLevels,
    ...inferRegions({ inspection, structure, roles }),
    headings: {
      article: joinOf(
        samplesOf(roles.articleHeading).filter(({ label }) => label !== null),
      ),
      annex: joinOf(annexSamples),
    },
    fields: {
      freezeKinds: kinds
        .filter((kind) => VOLATILE_FIELD_KINDS.has(kind))
        .toSorted(),
      liveKinds: kinds
        .filter((kind) => !VOLATILE_FIELD_KINDS.has(kind))
        .toSorted(),
    },
    fillerStrings: inferFillerStrings(inspection.blocks),
    annex,
    defaultAlignment:
      inspection.styles.find(
        ({ type, isDefault }) => type === "paragraph" && isDefault,
      )?.alignment ?? null,
    health: inferHealth(inspection),
    // A template without sample text shows no role in use, and one whose
    // body runs in columns is not filled by column yet.
    confidence:
      Math.min(...structural) *
      (columnTable ? UNCERTAIN_SHARE : 1) *
      (numberedSamples ? 1 : UNCERTAIN_SHARE),
  };
};

type ProfileIssueCode =
  | "templateMismatch"
  | "missingBodyRole"
  | "unknownStyle"
  | "unknownListLevel"
  | "listLevelChanged"
  | "sharedListLevel"
  | "unknownBlock"
  | "fieldKeptInPart";

export type TemplateProfileIssue = {
  severity: "error" | "warning";
  code: ProfileIssueCode;
  role?: HouseStyleRole;
  blockId?: string;
};

/** An issue for every spare or mark level the template does not have. */
const unknownLevelIssues = (
  profile: TemplateProfile,
  inspection: TemplateInspection,
  abstractByNum: ReadonlyMap<number, number>,
): TemplateProfileIssue[] =>
  [...profile.spareLevels, ...(profile.markLevels ?? [])].flatMap(
    ({ abstractNumId, numId, ilvl }): TemplateProfileIssue[] => {
      const known = inspection.numbering.abstractNums
        .find((list) => list.abstractNumId === abstractNumId)
        ?.levels.some((level) => level.ilvl === ilvl);
      return known === true && abstractByNum.get(numId) === abstractNumId
        ? []
        : [{ severity: "error", code: "unknownListLevel" }];
    },
  );

/**
 * Checks a profile against the template it is used with: a stored profile
 * outlives edits to its template, and a corrected one may name a style the
 * template lacks. An `error` means no plan can be built from it.
 */
export const validateTemplateProfile = (
  profile: TemplateProfile,
  inspection: TemplateInspection,
): TemplateProfileIssue[] => {
  const issues: TemplateProfileIssue[] = [];
  if (profile.templateSha256 !== inspection.sha256) {
    issues.push({ severity: "error", code: "templateMismatch" });
  }
  if (profile.roles.body === null) {
    issues.push({ severity: "error", code: "missingBodyRole", role: "body" });
  }
  const facts = new Map(
    collectStyleFacts(inspection).map((fact) => [fact.style.styleId, fact]),
  );
  const abstractByNum = new Map(
    inspection.numbering.nums.map(({ numId, abstractNumId }) => [
      numId,
      abstractNumId,
    ]),
  );
  const levelUsers = new Map<string, HouseStyleRole>();
  for (const role of HOUSE_STYLE_ROLES) {
    const roleTarget = profile.roles[role];
    if (roleTarget === null) {
      continue;
    }
    if (!facts.has(roleTarget.styleId)) {
      issues.push({ severity: "error", code: "unknownStyle", role });
    }
    const { numbering } = roleTarget;
    if (numbering === null) {
      continue;
    }
    const level = inspection.numbering.abstractNums
      .find(({ abstractNumId }) => abstractNumId === numbering.abstractNumId)
      ?.levels.find(({ ilvl }) => ilvl === numbering.ilvl);
    if (
      level === undefined ||
      abstractByNum.get(numbering.numId) !== numbering.abstractNumId
    ) {
      issues.push({ severity: "error", code: "unknownListLevel", role });
      continue;
    }
    if (
      level.numFmt !== numbering.numFmt ||
      level.lvlText !== numbering.lvlText
    ) {
      issues.push({ severity: "warning", code: "listLevelChanged", role });
    }
    const key = `${String(numbering.abstractNumId)}:${String(numbering.ilvl)}`;
    if (levelUsers.has(key)) {
      issues.push({ severity: "warning", code: "sharedListLevel", role });
    }
    levelUsers.set(key, role);
  }

  issues.push(...unknownLevelIssues(profile, inspection, abstractByNum));

  const { topLevel } = readStructure(inspection.blocks);
  const order = topLevel.map(({ id }) => id);
  const { keepBefore, contents, filler } = profile.regions;
  const slotIds = [profile.slots.party, profile.slots.signature].flatMap(
    (slot) => (slot === null ? [] : slot.blockIds),
  );
  for (const blockId of [...keepBefore, ...contents, ...filler, ...slotIds]) {
    if (!order.includes(blockId)) {
      issues.push({ severity: "error", code: "unknownBlock", blockId });
    }
  }
  // Every region that keeps template blocks, in the order they are placed:
  // the front blocks, then the contents.
  const emitted = [...keepBefore, ...contents];
  for (const { blockId, endBlockId } of inspection.fields) {
    if (blockId === undefined || endBlockId === undefined) {
      continue;
    }
    const span = order.slice(
      order.indexOf(blockId),
      order.indexOf(endBlockId) + 1,
    );
    // A field over several blocks is kept whole, in one run and in its
    // order, or not at all.
    const first = emitted.findIndex((id) => span.includes(id));
    const whole =
      first !== -1 &&
      span.every((id, offset) => emitted[first + offset] === id) &&
      emitted.filter((id) => span.includes(id)).length === span.length;
    if (first !== -1 && !whole) {
      issues.push({ severity: "error", code: "fieldKeptInPart", blockId });
    }
  }
  return issues;
};

/** Longest style id, number format, level text or placeholder kept. */
const TEXT_MAX = 255;
/** A list has nine levels. */
const LEVELS_MAX = 9;
/** Blocks of one template a profile may name. */
const BLOCKS_MAX = 20_000;
const FILLER_STRINGS_MAX = 1000;
const FIELD_KINDS_MAX = 100;
/** The widest page WordprocessingML allows, in twentieths of a point. */
const INDENT_MAX = 31_680;

const textSchema = v.pipe(v.string(), v.maxLength(TEXT_MAX));
const idSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(TEXT_MAX));

/** An indent in twentieths of a point; a negative one reaches into the margin. */
const twipsSchema = v.nullable(
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(-INDENT_MAX),
    v.maxValue(INDENT_MAX),
  ),
);

const listLevelSchema = v.strictObject({
  numId: v.pipe(v.number(), v.integer(), v.minValue(1)),
  ilvl: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(LEVELS_MAX - 1),
  ),
  abstractNumId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  numFmt: textSchema,
  lvlText: textSchema,
  start: v.pipe(v.number(), v.integer(), v.minValue(0)),
  indent: v.strictObject({
    left: twipsSchema,
    hanging: twipsSchema,
    firstLine: twipsSchema,
  }),
});

const confidenceSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

const roleTargetSchema = v.nullable(
  v.strictObject({
    styleId: idSchema,
    alignment: v.nullable(textSchema),
    numbering: v.nullable(listLevelSchema),
    confidence: confidenceSchema,
    evidence: v.pipe(
      v.array(v.picklist(ROLE_EVIDENCE)),
      v.maxLength(ROLE_EVIDENCE.length),
    ),
  }),
);

const blockIdsSchema = v.pipe(v.array(idSchema), v.maxLength(BLOCKS_MAX));
const slotSchema = v.nullable(v.strictObject({ blockIds: blockIdsSchema }));
const joinSchema = v.picklist(["sameLine", "lineBreak"]);
const fieldKindsSchema = v.pipe(
  v.array(
    v.pipe(v.string(), v.maxLength(TEXT_MAX), v.regex(/^[A-Z][A-Z0-9]*$/u)),
  ),
  v.maxLength(FIELD_KINDS_MAX),
);

const profileSchema = v.strictObject({
  version: v.literal(1),
  templateSha256: v.pipe(
    v.string(),
    v.maxLength(TEXT_MAX),
    v.regex(/^[0-9a-f]{64}$/u),
  ),
  layout: v.picklist(["flow", "parallelColumns"]),
  roles: v.strictObject({
    title: roleTargetSchema,
    party: roleTargetSchema,
    recital: roleTargetSchema,
    articleHeading: roleTargetSchema,
    clause1: roleTargetSchema,
    clause2: roleTargetSchema,
    clause3: roleTargetSchema,
    letter: roleTargetSchema,
    roman: roleTargetSchema,
    bullet: roleTargetSchema,
    continuation: roleTargetSchema,
    signature: roleTargetSchema,
    annexList: roleTargetSchema,
    annexHeading: roleTargetSchema,
    body: roleTargetSchema,
  } satisfies Record<HouseStyleRole, typeof roleTargetSchema>),
  spareLevels: v.pipe(v.array(listLevelSchema), v.maxLength(LEVELS_MAX)),
  markLevels: v.exactOptional(
    v.pipe(v.array(listLevelSchema), v.maxLength(LEVELS_MAX)),
  ),
  regions: v.strictObject({
    keepBefore: blockIdsSchema,
    contents: blockIdsSchema,
    filler: blockIdsSchema,
  }),
  slots: v.strictObject({ party: slotSchema, signature: slotSchema }),
  headings: v.strictObject({ article: joinSchema, annex: joinSchema }),
  fields: v.strictObject({
    freezeKinds: fieldKindsSchema,
    liveKinds: fieldKindsSchema,
  }),
  fillerStrings: v.pipe(v.array(textSchema), v.maxLength(FILLER_STRINGS_MAX)),
  annex: v.nullable(
    v.strictObject({ numbering: v.picklist(["list", "field", "typed"]) }),
  ),
  defaultAlignment: v.exactOptional(v.nullable(textSchema)),
  health: v.exactOptional(
    v.pipe(
      v.array(
        v.variant("kind", [
          v.strictObject({
            kind: v.literal("numberDrawnAsPicture"),
            abstractNumId: v.pipe(v.number(), v.integer()),
            ilvl: v.pipe(v.number(), v.integer(), v.minValue(0)),
          }),
          v.strictObject({
            kind: v.literal("textDrawnAsPicture"),
            styleId: v.nullable(textSchema),
          }),
        ]),
      ),
      v.maxLength(HEALTH_FINDINGS_MAX),
    ),
  ),
  confidence: confidenceSchema,
});

class TemplateProfileError extends TaggedError("TemplateProfileError")<{
  message: string;
}> {}

/** Reads a profile that was stored or edited outside this process. */
export const parseTemplateProfile = (
  input: unknown,
): Result<TemplateProfile, TemplateProfileError> => {
  const parsed = v.safeParse(profileSchema, input);
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(
        new TemplateProfileError({
          // The path only: an issue's message can quote the received value.
          message: `Template profile does not match its shape at ${v.getDotPath(parsed.issues[0]) ?? "the root"}`,
        }),
      );
};
