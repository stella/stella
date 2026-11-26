// A first, rule-based reading of what each source block is: a role with a
// confidence. Everything here is a proposal: the model step that follows
// reviews the uncertain ones, the plan builder maps roles onto the template,
// and the engine checks whatever plan comes out.

import { panic } from "better-result";

import type {
  DocxBlock,
  DocxBlockManifest,
} from "@/api/lib/templates/house-style/folio-contract";
import {
  buildLabelIndex,
  printedLabel,
} from "@/api/lib/templates/house-style/label-index";
import type {
  LabelEntry,
  LabelIndex,
} from "@/api/lib/templates/house-style/label-index";

export const HOUSE_STYLE_ROLES = [
  "title",
  "party",
  "recital",
  "articleHeading",
  "clause1",
  "clause2",
  "clause3",
  "letter",
  "roman",
  "bullet",
  "continuation",
  "signature",
  "annexList",
  "annexHeading",
  "heading",
  "body",
] as const;

export type HouseStyleRole = (typeof HOUSE_STYLE_ROLES)[number];

export type RoleProposal = {
  blockId: string;
  role: HouseStyleRole;
  confidence: number;
  /** Other readings worth offering the model, most likely first. */
  alternatives: { role: HouseStyleRole; confidence: number }[];
  /** The heading block this block's text is merged into; the block has no
   *  paragraph of its own in the output. */
  mergedIntoBlockId: string | null;
};

const CONFIDENCE = {
  namedArticle: 0.95,
  numberedArticle: 0.75,
  autoLabel: 0.9,
  typedLabel: 0.85,
  ambiguousNumeral: 0.3,
  annex: 0.85,
  recital: 0.6,
  titleShaped: 0.85,
  titleByPosition: 0.6,
  subtitle: 0.45,
  beforeTitle: 0.4,
  partyMarked: 0.85,
  partyByPosition: 0.6,
  preamble: 0.6,
  signatureMarked: 0.85,
  signatureByPosition: 0.6,
  continuation: 0.7,
  underHeading: 0.5,
  sectionHeading: 0.65,
  bullet: 0.35,
  annexBody: 0.4,
  plain: 0.5,
  alternative: 0.3,
  weakAlternative: 0.2,
} as const;

const NOT_LETTER = String.raw`(?![\p{L}])`;
const TITLE_STYLE = /title|název|nazev|titul|titel/iu;
const TITLE_MAX = 120;
const TITLE_CAPITAL_SHARE = 0.7;
const TITLE_LETTER_SHARE = 0.8;
const TITLE_LETTERS_MIN = 4;
/** What identifies a party: its seat, its number, who acts for it. */
const PARTY_IDENTITY_SOURCE = String.raw`se sídlem|sídlo:|IČO?${NOT_LETTER}|DIČ${NOT_LETTER}|zastoupen|zastupuje|jednající|bankovní spojení|zapsan[áýé] v|registered (?:office|seat)|incorporated|company (?:no|number)|represented by|mit Sitz in|vertreten durch|Handelsregister`;
const PARTY_IDENTITY = new RegExp(PARTY_IDENTITY_SOURCE, "iu");
/** Also the short name a party is given, which other defined terms share:
 *  it marks a party only among the parties. */
const PARTY_MARKER = new RegExp(
  String.raw`${PARTY_IDENTITY_SOURCE}|\(dále jen|\(hereinafter|\((?:the )?["“„]|\(nachfolgend|\(im Folgenden`,
  "iu",
);
const PREAMBLE_MARKER =
  /uzavřel[yi]|uzavírají|se dohodl[yi]|preambule|whereas|have agreed|agree as follows|präambel|vereinbaren/iu;
const SIGNATURE_MARKER = new RegExp(
  String.raw`^\s*(?:ve?[ \u00A0].{0,40}[ \u00A0]dne${NOT_LETTER}|(?:in|at)[ \u00A0].{0,40}[ ,]on${NOT_LETTER}|(?:ort|datum|date|place|místo)[^\n]{0,20}[:.…_]{2,}|(?:za|for and on behalf of|on behalf of|für|im namen)[ \u00A0])|_{4,}|\.{6,}|…{3,}|podpis|signature|unterschrift|signed by|name:|title:|jméno:|funkce:`,
  "iu",
);
/** What only a signature block holds: a place-and-date line, a line to sign
 *  on, the word itself. A cell of an ordinary table may read `Name:`; it
 *  takes one of these for a table to open the signatures. */
const SIGNING_MARKER = new RegExp(
  String.raw`^\s*(?:ve?[ \u00A0].{0,40}[ \u00A0]dne${NOT_LETTER}|(?:in|at)[ \u00A0].{0,40}[ ,]on${NOT_LETTER})|_{4,}|\.{6,}|…{3,}|podpis|signature|unterschrift|signed by`,
  "iu",
);
const CLAUSE_DEPTH_ROLES = [
  "clause1",
  "clause2",
  "clause3",
] as const satisfies readonly HouseStyleRole[];

const isTitleShaped = ({ styleName, text }: DocxBlock): boolean => {
  if (styleName !== null && TITLE_STYLE.test(styleName)) {
    return true;
  }
  const trimmed = text.trim();
  const letters = trimmed.match(/\p{L}/gu)?.length ?? 0;
  const capitals = trimmed.match(/\p{Lu}/gu)?.length ?? 0;
  const printed = trimmed.match(/\S/gu)?.length ?? 0;
  // Capitals, and words rather than a file reference in capitals.
  return (
    trimmed.length <= TITLE_MAX &&
    letters >= TITLE_LETTERS_MIN &&
    letters >= printed * TITLE_LETTER_SHARE &&
    capitals >= letters * TITLE_CAPITAL_SHARE
  );
};

/** A list bullet as the engine reports it: one mark, no number. */
const isBulletMark = (label: string): boolean =>
  /^[^\p{L}\p{N}\s%]$/u.test(label.trim());

/** Whether a list prints a bullet in front of the paragraph: the engine
 *  says so of the level, or the label is a lone mark. */
export const isBulleted = ({
  label,
  numbering,
}: Pick<DocxBlock, "label" | "numbering">): boolean =>
  label !== null && (numbering?.bullet === true || isBulletMark(label));

type Reading = Omit<RoleProposal, "blockId" | "mergedIntoBlockId">;

const reading = (
  role: HouseStyleRole,
  confidence: number,
  ...alternatives: RoleProposal["alternatives"]
): Reading => ({ role, confidence, alternatives });

const isAmbiguousNumeral = ({ shape }: LabelEntry): boolean =>
  shape.numeral === "lowerAmbiguous" || shape.numeral === "upperAmbiguous";

const readEntry = (entry: LabelEntry, zones: Zones): Reading => {
  const labelled =
    entry.origin === "auto" ? CONFIDENCE.autoLabel : CONFIDENCE.typedLabel;
  switch (entry.level) {
    case "article":
      return reading(
        "articleHeading",
        entry.shape.keyword !== null || entry.shape.numeral !== "decimal"
          ? CONFIDENCE.namedArticle
          : CONFIDENCE.numberedArticle,
        { role: "clause1", confidence: CONFIDENCE.weakAlternative },
      );
    case "clause": {
      const depth = Math.min(
        entry.clausePath.length,
        CLAUSE_DEPTH_ROLES.length,
      );
      return reading(
        CLAUSE_DEPTH_ROLES[Math.max(depth, 1) - 1] ?? "clause1",
        labelled,
      );
    }
    case "letter":
      return isAmbiguousNumeral(entry)
        ? reading("letter", labelled, {
            role: "roman",
            confidence: CONFIDENCE.ambiguousNumeral,
          })
        : reading("letter", labelled);
    case "roman":
      return isAmbiguousNumeral(entry)
        ? reading("roman", labelled, {
            role: "letter",
            confidence: CONFIDENCE.ambiguousNumeral,
          })
        : reading("roman", labelled);
    case "annex":
      return entry.listed
        ? reading("annexList", CONFIDENCE.annex, {
            role: "annexHeading",
            confidence: CONFIDENCE.weakAlternative,
          })
        : reading("annexHeading", CONFIDENCE.annex, {
            role: "annexList",
            confidence: CONFIDENCE.weakAlternative,
          });
    case "recital":
      // Recitals stand in front of the operative part. A capital letter
      // that labels a paragraph inside an article heads a subsection or an
      // item of a list there.
      return entry.position > zones.firstProvision
        ? reading("letter", CONFIDENCE.recital, {
            role: "continuation",
            confidence: CONFIDENCE.alternative,
          })
        : reading("recital", CONFIDENCE.recital, {
            role: "body",
            confidence: CONFIDENCE.alternative,
          });
    default: {
      entry.level satisfies never;
      return panic("Unhandled level");
    }
  }
};

/**
 * Whether a paragraph is set like a title: in a title's style or in
 * capitals, or a short line that is no sentence and stands centred or in
 * the document's first heading style.
 */
export const isSetAsTitle = (block: DocxBlock): boolean => {
  if (isTitleShaped(block)) {
    return true;
  }
  const line = block.text.trim();
  return (
    (block.alignment === "center" || block.outlineLevel === 0) &&
    line.length <= TITLE_MAX &&
    /\p{L}/u.test(line) &&
    !/[.;:,]$/u.test(line)
  );
};

/**
 * Whether a paragraph is a further line of the title in front of it: set
 * in the same style and alignment, as a heading or centred, and no
 * sentence.
 */
const continuesCaption = (block: DocxBlock, title: DocxBlock): boolean => {
  const line = block.text.trim();
  return (
    block.styleName === title.styleName &&
    block.alignment === title.alignment &&
    (block.outlineLevel !== null || block.alignment === "center") &&
    block.label === null &&
    line.length <= TITLE_MAX &&
    /\p{L}/u.test(line) &&
    !/[.;:,]$/u.test(line)
  );
};

/** The document's zones by block position; `Infinity` for a zone the
 *  document does not have. */
type Zones = {
  firstProvision: number;
  title: number;
  firstParty: number;
  preamble: number;
  signature: number;
  firstAnnexHeading: number;
};

const firstPosition = (
  blocks: readonly DocxBlock[],
  from: number,
  until: number,
  test: (block: DocxBlock) => boolean,
): number => {
  for (
    let position = Math.max(from, 0);
    position < blocks.length;
    position += 1
  ) {
    if (position >= until) {
      break;
    }
    const block = blocks[position];
    if (block?.kind === "paragraph" && test(block)) {
      return position;
    }
  }
  return Number.POSITIVE_INFINITY;
};

const isProvision = ({ level, annexBlockId }: LabelEntry): boolean =>
  annexBlockId === null &&
  (level === "article" ||
    level === "clause" ||
    level === "letter" ||
    level === "roman");

const findZones = (
  all: readonly DocxBlock[],
  { entries }: LabelIndex,
  nested: ReadonlySet<string>,
): Zones => {
  // Cell paragraphs are placed with their table and are no title; a blank
  // stand-in keeps every other block at its position. What a table holds
  // still tells where the parties and the signatures are: both are often
  // laid out in one.
  const blocks = all.map((block): DocxBlock =>
    nested.has(block.id) ? { ...block, kind: "table", text: "" } : block,
  );
  const provisions = entries.filter(isProvision);
  const firstProvision = provisions.at(0)?.position ?? Number.POSITIVE_INFINITY;
  const lastProvision = provisions.at(-1)?.position ?? -1;
  const firstAnnexHeading =
    entries.find(({ level, listed }) => level === "annex" && !listed)
      ?.position ?? Number.POSITIVE_INFINITY;
  const isText = (block: DocxBlock) => block.text.trim() !== "";
  const shaped = firstPosition(
    blocks,
    0,
    firstProvision,
    (block) => isText(block) && isSetAsTitle(block),
  );
  const title = Number.isFinite(shaped)
    ? shaped
    : firstPosition(blocks, 0, firstProvision, isText);
  const identified = firstPosition(all, title + 1, firstProvision, (block) =>
    PARTY_IDENTITY.test(block.text),
  );
  // A party's name often stands alone on the line above its details.
  const named = blocks[identified - 1];
  const firstParty =
    named !== undefined &&
    identified - 1 > title &&
    named.kind === "paragraph" &&
    isText(named) &&
    named.text.trim().length <= TITLE_MAX
      ? identified - 1
      : identified;
  const preamble = firstPosition(
    all,
    (Number.isFinite(firstParty) ? firstParty : title) + 1,
    firstProvision,
    (block) => PREAMBLE_MARKER.test(block.text),
  );
  return {
    firstProvision,
    title,
    firstParty,
    preamble,
    // Without numbered provisions there is no body for a signature block
    // to follow: a letter or a memo has a title and body text.
    signature:
      lastProvision < 0
        ? Number.POSITIVE_INFINITY
        : firstPosition(all, lastProvision + 1, firstAnnexHeading, (block) =>
            (nested.has(block.id) ? SIGNING_MARKER : SIGNATURE_MARKER).test(
              block.text,
            ),
          ),
    firstAnnexHeading,
  };
};

const readFrontMatter = (
  block: DocxBlock,
  position: number,
  zones: Zones,
): Reading => {
  if (!Number.isFinite(zones.firstProvision)) {
    // No numbered provisions: a letter or a memo. Only its title is told
    // apart.
    return position === zones.title && isTitleShaped(block)
      ? reading("title", CONFIDENCE.titleShaped)
      : reading("body", CONFIDENCE.plain);
  }
  if (position < zones.title) {
    return reading("body", CONFIDENCE.beforeTitle, {
      role: "title",
      confidence: CONFIDENCE.weakAlternative,
    });
  }
  if (position === zones.title) {
    return reading(
      "title",
      isTitleShaped(block)
        ? CONFIDENCE.titleShaped
        : CONFIDENCE.titleByPosition,
    );
  }
  if (position >= zones.preamble) {
    // The line that heads the preamble is a heading, not a recital.
    if (isSectionHeading(block)) {
      return sectionHeading();
    }
    return reading("recital", CONFIDENCE.preamble, {
      role: "body",
      confidence: CONFIDENCE.alternative,
    });
  }
  if (position >= zones.firstParty) {
    return PARTY_MARKER.test(block.text)
      ? reading("party", CONFIDENCE.partyMarked)
      : reading("party", CONFIDENCE.partyByPosition, {
          role: "body",
          confidence: CONFIDENCE.alternative,
        });
  }
  // Between the title and the parties a line belongs to the title when it
  // is set like one: centred, or in capitals. Anything else there is text
  // (a note on how to fill the form in, a sentence that opens the deed).
  // A line in brackets under the title (`(dále jen „Smlouva“)`) names the
  // document for the text that follows; it is no line of the title.
  const bracketed = /^\(.*\)$/su.test(block.text.trim());
  return !bracketed && (block.alignment === "center" || isTitleShaped(block))
    ? reading("title", CONFIDENCE.subtitle, {
        role: "body",
        confidence: CONFIDENCE.beforeTitle,
      })
    : reading("body", CONFIDENCE.plain, {
        role: "title",
        confidence: CONFIDENCE.weakAlternative,
      });
};

/** A typed article label at the start of a line: `Article 3`, `Článek IV`,
 *  `§ 2`. */
const NAMED_ARTICLE =
  /^(?:article|clause|section|článek|čl\.|artikel|§)[ \u00A0]*(?:\d+|[IVXLC]+)(?![\p{L}\d.])/iu;

/**
 * Whether a paragraph the label index reads no label on is still set as an
 * article's heading: a heading of the source that opens with an article's
 * name and goes on as a title. A part of the document that counts its own
 * articles (a model contract in an annex) has such headings; the index
 * leaves them out, because the number is taken, and they keep their typed
 * label.
 */
const isTypedArticleHeading = (block: DocxBlock): boolean => {
  const line = block.text.trim();
  return (
    block.outlineLevel !== null &&
    NAMED_ARTICLE.test(line) &&
    line.length <= TITLE_MAX &&
    !/[.;:,]$/u.test(line)
  );
};

/**
 * Whether a paragraph without a number heads a part of the document: a
 * short line that is no sentence and that the source sets as a heading or
 * centres (`Preambule`, `Definice`, `Závěrečná ustanovení` over unnumbered
 * text). A line in brackets names something for the text that follows.
 */
const isSectionHeading = (block: DocxBlock): boolean => {
  const line = block.text.trim();
  return (
    printedLabel(block) === null &&
    (block.outlineLevel !== null || block.alignment === "center") &&
    line.length <= TITLE_MAX &&
    /\p{L}{2}/u.test(line) &&
    !/[.;:,]$/u.test(line) &&
    !/^\(.*\)$/su.test(line) &&
    !SIGNATURE_MARKER.test(line)
  );
};

const sectionHeading = (): Reading =>
  reading("heading", CONFIDENCE.sectionHeading, {
    role: "continuation",
    confidence: CONFIDENCE.alternative,
  });

const readUnlabelled = (
  block: DocxBlock,
  position: number,
  zones: Zones,
  index: LabelIndex,
): Reading => {
  if (isTypedArticleHeading(block)) {
    return reading("articleHeading", CONFIDENCE.titleByPosition, {
      role: "body",
      confidence: CONFIDENCE.alternative,
    });
  }
  if (position >= zones.firstAnnexHeading) {
    return isSectionHeading(block)
      ? sectionHeading()
      : reading("body", CONFIDENCE.annexBody);
  }
  if (position >= zones.signature) {
    return SIGNATURE_MARKER.test(block.text)
      ? reading("signature", CONFIDENCE.signatureMarked)
      : reading("signature", CONFIDENCE.signatureByPosition, {
          role: "body",
          confidence: CONFIDENCE.alternative,
        });
  }
  if (position < zones.firstProvision) {
    return readFrontMatter(block, position, zones);
  }
  // A list the label index does not count: bullets and dashes, or a label
  // it could not read.
  const label = printedLabel(block);
  if (label !== null) {
    return isBulleted(block)
      ? reading("bullet", CONFIDENCE.autoLabel)
      : reading("continuation", CONFIDENCE.bullet, {
          role: "letter",
          confidence: CONFIDENCE.alternative,
        });
  }
  if (isSectionHeading(block)) {
    return sectionHeading();
  }
  const context = index.contextByBlockId.get(block.id);
  const inProvision =
    context !== undefined &&
    (context.clauseBlockId !== null || context.itemBlockId !== null);
  return inProvision
    ? reading("continuation", CONFIDENCE.continuation, {
        role: "body",
        confidence: CONFIDENCE.weakAlternative,
      })
    : reading("continuation", CONFIDENCE.underHeading, {
        role: "body",
        confidence: CONFIDENCE.beforeTitle,
      });
};

const LAID_OUT_ROLES: ReadonlySet<HouseStyleRole> = new Set([
  "party",
  "signature",
]);

type ProposeOptions = {
  manifest: Pick<DocxBlockManifest, "blocks">;
  /** Pass the index when the caller already built one from this manifest. */
  index?: LabelIndex;
};

/** Whether a paragraph shows nothing: no text, no label, no object. */
export const isBlankParagraph = ({
  text,
  label,
  inlineObjects = 0,
}: DocxBlock): boolean =>
  text.trim() === "" && printedLabel({ label }) === null && inlineObjects === 0;

/**
 * Proposes a role for every paragraph of the main story that stands on its
 * own: not a line of the source's table of contents, not blank, and in a
 * table only a numbered provision. The second half of a split heading is
 * reported with the heading it belongs to.
 */
export const proposeBlockRoles = ({
  manifest: { blocks },
  index = buildLabelIndex({ blocks }),
}: ProposeOptions): RoleProposal[] => {
  const nested = new Set(
    blocks.flatMap((block) =>
      block.cells === undefined
        ? []
        : block.cells.flatMap((cell) => cell.blockIds),
    ),
  );
  const zones = findZones(blocks, index, nested);
  const titleOwner = new Map(
    index.entries.flatMap((entry) =>
      entry.titleBlockId === null ? [] : [[entry.titleBlockId, entry] as const],
    ),
  );
  const proposals: RoleProposal[] = [];
  /** The title paragraph read last, with nothing but its own lines since. */
  let caption: { owner: LabelEntry; title: DocxBlock } | null = null;
  for (const [position, block] of blocks.entries()) {
    if (
      block.kind === "table" ||
      index.contentsBlockIds.has(block.id) ||
      isBlankParagraph(block)
    ) {
      caption = null;
      continue;
    }
    if (nested.has(block.id)) {
      // A cell paragraph is placed with its table. It is read on its own
      // where it is a provision in its own right: numbered by a list, or a
      // paragraph of a text that runs in parallel columns.
      const entry = index.entryByBlockId.get(block.id);
      if (
        entry !== undefined &&
        (entry.origin === "auto" || index.columnByBlockId.has(block.id))
      ) {
        proposals.push({
          ...readEntry(entry, zones),
          blockId: block.id,
          mergedIntoBlockId: null,
        });
        continue;
      }
      // A table of parties or of signatures is laid out, not tabulated: its
      // paragraphs are party and signature lines.
      const read = readUnlabelled(block, position, zones, index);
      if (LAID_OUT_ROLES.has(read.role)) {
        proposals.push({ ...read, blockId: block.id, mergedIntoBlockId: null });
      }
      continue;
    }
    const owner = titleOwner.get(block.id);
    if (owner !== undefined) {
      proposals.push({
        ...readEntry(owner, zones),
        blockId: block.id,
        mergedIntoBlockId: owner.blockId,
      });
      caption = { owner, title: block };
      continue;
    }
    const entry = index.entryByBlockId.get(block.id);
    // A title that runs over two paragraphs: the line behind a heading's
    // title, set as the title is, belongs to the heading too.
    if (
      entry === undefined &&
      caption !== null &&
      continuesCaption(block, caption.title)
    ) {
      proposals.push({
        ...readEntry(caption.owner, zones),
        blockId: block.id,
        mergedIntoBlockId: caption.owner.blockId,
      });
      continue;
    }
    caption = null;
    proposals.push({
      ...(entry === undefined
        ? readUnlabelled(block, position, zones, index)
        : readEntry(entry, zones)),
      blockId: block.id,
      mergedIntoBlockId: null,
    });
  }
  return proposals;
};
