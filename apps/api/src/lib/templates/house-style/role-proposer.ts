// A first, rule-based reading of what each source block is, mapped onto the
// template's styles and list levels as plan items. Everything here is a
// proposal with a confidence: the model step that follows reviews the
// uncertain ones, and the engine checks whatever plan comes out.

import { panic } from "better-result";

import { parseRomanNumeral } from "@stll/api-contract/magyar-kozlony-designation";

import { letterOrdinal } from "@/api/lib/templates/house-style/designators";
import type {
  DocxBlock,
  DocxBlockManifest,
  TemplatePlan,
  TemplatePlanSourceItem,
} from "@/api/lib/templates/house-style/folio-contract";
import { buildLabelIndex } from "@/api/lib/templates/house-style/label-index";
import type {
  LabelEntry,
  LabelIndex,
} from "@/api/lib/templates/house-style/label-index";

export type HouseStyleRole =
  | "title"
  | "party"
  | "articleHeading"
  | "clause1"
  | "clause2"
  | "clause3"
  | "letter"
  | "roman"
  | "continuation"
  | "signature"
  | "annexList"
  | "annexHeading"
  | "body";

/** Where a role lands in the template. */
type TemplateRoleTarget = {
  styleId: string;
  /** The list level that numbers the role; null for an unnumbered role. */
  numbering: { numId: number; ilvl: number } | null;
};

/** Total on purpose: a template that has nothing for a role says so with
 *  `null`, and the proposer reports the blocks that needed it. */
export type TemplateRoleMap = Readonly<
  Record<HouseStyleRole, TemplateRoleTarget | null>
>;

type RoleProposal = {
  blockId: string;
  role: HouseStyleRole;
  confidence: number;
  /** Other readings worth offering the model, most likely first. */
  alternatives: { role: HouseStyleRole; confidence: number }[];
  /** The heading block this block's text is merged into; the block has no
   *  plan item of its own. */
  mergedIntoBlockId: string | null;
};

type RolePlanProposal = {
  /** Plan items for every placed block, in document order. Tables are
   *  placed as they are and carry no role. */
  body: TemplatePlanSourceItem[];
  omit: TemplatePlan["omit"];
  proposals: RoleProposal[];
  /** Proposed roles the template has no target for; their blocks were
   *  given the `body` target, or none. */
  unmappedRoles: HouseStyleRole[];
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

type Reading = Omit<RoleProposal, "blockId" | "mergedIntoBlockId">;

const reading = (
  role: HouseStyleRole,
  confidence: number,
  ...alternatives: RoleProposal["alternatives"]
): Reading => ({ role, confidence, alternatives });

const isAmbiguousNumeral = ({ shape }: LabelEntry): boolean =>
  shape.numeral === "lowerAmbiguous" || shape.numeral === "upperAmbiguous";

const readEntry = (entry: LabelEntry): Reading => {
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
      return reading("body", CONFIDENCE.recital);
    default: {
      entry.level satisfies never;
      return panic("Unhandled level");
    }
  }
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
  blocks: readonly DocxBlock[],
  { entries }: LabelIndex,
): Zones => {
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
    (block) => isText(block) && isTitleShaped(block),
  );
  const title = Number.isFinite(shaped)
    ? shaped
    : firstPosition(blocks, 0, firstProvision, isText);
  const identified = firstPosition(blocks, title + 1, firstProvision, (block) =>
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
    blocks,
    (Number.isFinite(firstParty) ? firstParty : title) + 1,
    firstProvision,
    (block) => PREAMBLE_MARKER.test(block.text),
  );
  return {
    firstProvision,
    title,
    firstParty,
    preamble,
    signature: firstPosition(
      blocks,
      lastProvision + 1,
      firstAnnexHeading,
      (block) => SIGNATURE_MARKER.test(block.text),
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
    return reading("body", CONFIDENCE.preamble, {
      role: "continuation",
      confidence: CONFIDENCE.weakAlternative,
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
  return reading("title", CONFIDENCE.subtitle, {
    role: "body",
    confidence: CONFIDENCE.beforeTitle,
  });
};

const readUnlabelled = (
  block: DocxBlock,
  position: number,
  zones: Zones,
  index: LabelIndex,
): Reading => {
  if (position >= zones.firstAnnexHeading) {
    return reading("body", CONFIDENCE.annexBody);
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
  // A bullet or a dash: a list the label index does not count.
  if (block.label !== null) {
    return reading("continuation", CONFIDENCE.bullet, {
      role: "letter",
      confidence: CONFIDENCE.alternative,
    });
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

/** The ordinal a list level must show to print the source's designator. */
const sourceOrdinal = (entry: LabelEntry): number | null => {
  switch (entry.level) {
    case "article":
    case "clause":
    case "annex":
      return entry.ordinal;
    case "letter":
      return letterOrdinal(entry.core);
    case "roman":
      return parseRomanNumeral(entry.core);
    case "recital":
      return null;
    default: {
      entry.level satisfies never;
      return panic("Unhandled level");
    }
  }
};

type ProposeOptions = {
  manifest: Pick<DocxBlockManifest, "blocks">;
  roleMap: TemplateRoleMap;
  /** Pass the index when the caller already built one from this manifest. */
  index?: LabelIndex;
};

/**
 * Proposes a role and a plan item for every block of the main story. List
 * items carry `restartFrom` wherever the template's list would otherwise
 * count past the source's designator, so the output prints the source's
 * numbers.
 */
export const proposeTemplateRoles = ({
  manifest: { blocks },
  roleMap,
  index = buildLabelIndex({ blocks }),
}: ProposeOptions): RolePlanProposal => {
  const nested = new Set(
    blocks.flatMap((block) =>
      block.cells === undefined
        ? []
        : block.cells.flatMap((cell) => cell.blockIds),
    ),
  );
  const zones = findZones(blocks, index);
  const titleOwner = new Map(
    index.entries.flatMap((entry) =>
      entry.titleBlockId === null ? [] : [[entry.titleBlockId, entry] as const],
    ),
  );
  const result: RolePlanProposal = {
    body: [],
    omit: [],
    proposals: [],
    unmappedRoles: [],
  };
  const unmapped = new Set<HouseStyleRole>();
  const countersByList = new Map<number, number[]>();

  const place = (block: DocxBlock, read: Reading, entry: LabelEntry | null) => {
    result.proposals.push({
      ...read,
      blockId: block.id,
      mergedIntoBlockId: null,
    });
    const own = roleMap[read.role];
    if (own === null) {
      unmapped.add(read.role);
    }
    const target = own ?? roleMap.body;
    const item: TemplatePlanSourceItem = {
      kind: "source",
      blockId: block.id,
      hash: block.hash,
    };
    if (target !== null) {
      item.styleId = target.styleId;
      item.numbering = null;
    }
    // Only the role's own list numbers the block; the fallback style does
    // not turn a clause into a numbered body paragraph.
    const list = own?.numbering ?? null;
    if (list !== null && entry !== null) {
      const { numId, ilvl } = list;
      const counters = countersByList.get(numId);
      const expected = (counters?.[ilvl] ?? 0) + 1;
      const ordinal = sourceOrdinal(entry) ?? expected;
      item.numbering =
        ordinal === expected
          ? { numId, ilvl }
          : { numId, ilvl, restartFrom: ordinal };
      // Placing an item resets every deeper level of its list.
      const next = Array.from(
        { length: ilvl },
        (_, level) => counters?.[level] ?? 0,
      );
      next.push(ordinal);
      countersByList.set(numId, next);
      if (entry.origin === "manual") {
        item.stripLabel = block.text.slice(0, entry.manualLength);
      }
    }
    if (entry !== null && entry.titleBlockId !== null) {
      item.mergeNext = "lineBreak";
    }
    result.body.push(item);
  };

  for (const [position, block] of blocks.entries()) {
    if (nested.has(block.id)) {
      continue;
    }
    if (block.kind === "table") {
      result.body.push({ kind: "source", blockId: block.id, hash: block.hash });
      continue;
    }
    if (index.contentsBlockIds.has(block.id)) {
      result.omit.push({ blockId: block.id, reason: "sourceToc" });
      continue;
    }
    if (block.text.trim() === "" && block.label === null) {
      result.omit.push({ blockId: block.id, reason: "empty" });
      continue;
    }
    const owner = titleOwner.get(block.id);
    if (owner !== undefined) {
      result.proposals.push({
        ...readEntry(owner),
        blockId: block.id,
        mergedIntoBlockId: owner.blockId,
      });
      continue;
    }
    const entry = index.entryByBlockId.get(block.id) ?? null;
    place(
      block,
      entry === null
        ? readUnlabelled(block, position, zones, index)
        : readEntry(entry),
      entry,
    );
  }
  result.unmappedRoles = [...unmapped];
  return result;
};
