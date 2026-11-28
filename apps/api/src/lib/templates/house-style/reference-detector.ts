// Finds the cross-references in a document's text and resolves the internal
// ones against the document's own numbering.
//
// A reference is a chain of head words and designators: `čl. XI. odst. 1 a
// odst. 2 písm. d) této smlouvy`, `Section 2.3(b)`, `§ 5 Abs. 2 dieses
// Vertrages`. Each designator is its own span, because each becomes its own
// field in the output; connectors and head words stay text. A chain that names
// legislation or another document is reported as external and left alone.

import { panic } from "better-result";

import { parseRomanNumeral } from "@stll/api-contract/magyar-kozlony-designation";

import type {
  DocxBlock,
  DocxBlockManifest,
} from "@/api/lib/templates/house-style/folio-contract";
import { buildLabelIndex } from "@/api/lib/templates/house-style/label-index";
import type {
  BlockContext,
  LabelEntry,
  LabelIndex,
  LabelLevel,
} from "@/api/lib/templates/house-style/label-index";
import { readChains } from "@/api/lib/templates/house-style/reference-chain";
import type {
  Chain,
  TailEvidence,
} from "@/api/lib/templates/house-style/reference-chain";
import {
  buildUnits,
  tokenOrdinal,
} from "@/api/lib/templates/house-style/reference-units";
import type { Unit } from "@/api/lib/templates/house-style/reference-units";

/** Why a chain was read as internal or external. Codes, never text: the
 *  model step that adjudicates the unknown ones is given no document text. */
type ReferenceEvidence =
  | TailEvidence
  /** `§` in a document that does not head its own articles with it. */
  | "sectionSign"
  /** Every designator names a provision the document has. */
  | "ownNumbering"
  /** A provision inside an annex; annex bodies are not indexed. */
  | "withinAnnex"
  /** `č.` stands where `čl.` would: possibly a slip, possibly a number of
   *  something else. Never linked without the model's decision. */
  | "looseHead"
  /** The source holds the citation as a field of its own that points at a
   *  provision of the document. */
  | "sourceField";

type ReferenceResolution =
  | { status: "resolved"; targetBlockId: string; confidence: number }
  | {
      status: "ambiguous";
      candidates: { targetBlockId: string; confidence: number }[];
    }
  | { status: "unresolved"; reason: "missingTarget" | "withinAnnex" }
  /** External chains are not resolved. */
  | { status: "skipped" };

type ReferenceDesignator = {
  /** Offsets into the block's text; brackets are inside the span, a closing
   *  period is not. */
  start: number;
  end: number;
  level: LabelLevel;
  /** How the designator is joined to the one before it at the same level. */
  join: "list" | "range" | null;
  resolution: ReferenceResolution;
};

export type DetectedReference = {
  /** `<blockId>:<start>`; stable for one manifest. */
  id: string;
  blockId: string;
  start: number;
  end: number;
  scope: "internal" | "external" | "unknown";
  /** Confidence in `scope`. */
  confidence: number;
  evidence: ReferenceEvidence[];
  designators: ReferenceDesignator[];
};

/** A decision left to the model step: ids and enumerated options only. */
type ReferenceAmbiguity =
  | {
      kind: "scope";
      referenceId: string;
      options: readonly ["internal", "external"];
    }
  | {
      kind: "target";
      referenceId: string;
      designatorIndex: number;
      candidates: { targetBlockId: string; confidence: number }[];
    };

type ReferenceDetection = {
  references: DetectedReference[];
  ambiguities: ReferenceAmbiguity[];
};

const CONFIDENCE = {
  explicit: 0.9,
  selfDeictic: 0.97,
  relativeDeictic: 0.92,
  relativeImplicit: 0.75,
  /** The path was found only on a second reading of the designator. */
  fallback: 0.6,
  /** A designator that follows `a`, `and`, `und` without a head of its own. */
  listed: 0.8,
  ambiguousTotal: 0.9,
  statute: 0.95,
  sectionSign: 0.9,
  abbreviation: 0.9,
  namedDocument: 0.8,
  ownNoun: 0.85,
  ownNumbering: 0.85,
  /** The source's own field points at the provision. */
  sourceField: 0.98,
  unknown: 0.5,
} as const;

type Lookup = {
  index: LabelIndex;
  childrenByParent: ReadonlyMap<string, LabelEntry[]>;
};

const samePath = (left: readonly number[], right: readonly number[]) =>
  left.length === right.length &&
  left.every((value, position) => value === right[position]);

const bodyEntries = ({ index }: Lookup, level: LabelLevel): LabelEntry[] =>
  index.entries.filter(
    (entry) => entry.level === level && entry.annexBlockId === null,
  );

const clausesOfArticle = (
  lookup: Lookup,
  ordinal: number | null,
  path: readonly number[],
): LabelEntry[] =>
  ordinal === null
    ? []
    : bodyEntries(lookup, "clause").filter(
        (entry) =>
          entry.articleOrdinal === ordinal && samePath(entry.clausePath, path),
      );

const clausesInContext = (
  { index }: Lookup,
  context: BlockContext,
  path: readonly number[],
): LabelEntry[] =>
  index.entries.filter(
    (entry) =>
      entry.level === "clause" &&
      entry.articleBlockId === context.articleBlockId &&
      entry.annexBlockId === context.annexBlockId &&
      samePath(entry.clausePath, path),
  );

const itemsUnder = (
  { childrenByParent }: Lookup,
  parents: readonly LabelEntry[],
  core: string,
  preferLetter: boolean,
): LabelEntry[] => {
  const found = parents.flatMap((parent) => {
    // A provision without items has no entry in the map.
    const children = childrenByParent.get(parent.blockId);
    return children === undefined
      ? []
      : children.filter(
          (child) =>
            (child.level === "letter" || child.level === "roman") &&
            child.core === core,
        );
  });
  const letters = found.filter((entry) => entry.level === "letter");
  return preferLetter && letters.length > 0 ? letters : found;
};

/** The nearest provision around the citing block that has such an item:
 *  `písm. b)` said inside letter a) of a clause means that clause's b). */
const itemsAround = (
  lookup: Lookup,
  context: BlockContext,
  core: string,
  preferLetter: boolean,
): LabelEntry[] => {
  let around =
    context.itemBlockId ?? context.clauseBlockId ?? context.articleBlockId;
  while (around !== null) {
    const entry = lookup.index.entryByBlockId.get(around);
    if (entry === undefined) {
      return [];
    }
    const found = itemsUnder(lookup, [entry], core, preferLetter);
    if (found.length > 0) {
      return found;
    }
    around = entry.parentBlockId;
  }
  return [];
};

type Candidates = { entries: LabelEntry[]; confidence: number };

const NONE: Candidates = { entries: [], confidence: 0 };

const firstFound = (...readings: (() => Candidates)[]): Candidates => {
  for (const reading of readings) {
    const candidates = reading();
    if (candidates.entries.length > 0) {
      return candidates;
    }
  }
  return NONE;
};

type ResolveOptions = {
  lookup: Lookup;
  context: BlockContext;
  /** Confidence of a path the chain spells out in full. */
  explicit: number;
  /** Confidence of a path read from the citing block's place. */
  relative: number;
  /** The chain says `tohoto článku`: only the citing article is meant. */
  ownArticle: boolean;
};

const resolveClause = (
  { lookup, context, explicit, relative, ownArticle }: ResolveOptions,
  unit: Unit,
  path: readonly number[],
): Candidates => {
  const { relativePath } = unit;
  const absolute = clausesOfArticle(
    lookup,
    unit.article?.ordinal ?? null,
    path,
  );
  if (unit.article !== null && relativePath === null) {
    return { entries: absolute, confidence: explicit };
  }
  if (relativePath === null) {
    return {
      entries: clausesInContext(lookup, context, path),
      confidence: relative,
    };
  }
  // `odst. 2.1` reads two ways: paragraph 1 of article 2, or sub-paragraph
  // 2.1 of the citing article.
  const inContext = clausesInContext(lookup, context, relativePath);
  if (ownArticle) {
    return firstFound(
      () => ({ entries: inContext, confidence: relative }),
      () => ({
        entries: absolute.filter(
          (entry) => entry.articleBlockId === context.articleBlockId,
        ),
        confidence: relative,
      }),
    );
  }
  if (absolute.length === 0) {
    return { entries: inContext, confidence: CONFIDENCE.fallback };
  }
  // Both exist: offered, not chosen.
  const others = inContext.filter((entry) => !absolute.includes(entry));
  return { entries: [...absolute, ...others], confidence: explicit };
};

const resolveItem = (options: ResolveOptions, unit: Unit): Candidates => {
  const { lookup, context, explicit, relative } = options;
  const [first, ...deeper] = unit.items;
  if (first === undefined) {
    return NONE;
  }
  let found: Candidates;
  if (unit.clausePath !== null) {
    const clauses = resolveClause(options, unit, unit.clausePath);
    found = {
      entries: itemsUnder(lookup, clauses.entries, first, unit.preferLetter),
      confidence: clauses.confidence,
    };
  } else if (unit.article !== null) {
    const { ordinal } = unit.article;
    const articles = bodyEntries(lookup, "article").filter(
      (entry) => entry.ordinal === ordinal,
    );
    found = firstFound(
      () => ({
        entries: itemsUnder(lookup, articles, first, unit.preferLetter),
        confidence: explicit,
      }),
      // An article whose only clause is unnumbered text keeps its letters
      // one level down.
      () => ({
        entries: lookup.index.entries.filter(
          (entry) =>
            (entry.level === "letter" || entry.level === "roman") &&
            entry.core === first &&
            entry.annexBlockId === null &&
            entry.articleOrdinal === ordinal &&
            ordinal !== null,
        ),
        confidence: CONFIDENCE.fallback,
      }),
    );
  } else {
    found = {
      entries: itemsAround(lookup, context, first, unit.preferLetter),
      confidence: relative,
    };
  }
  for (const core of deeper) {
    found = {
      entries: itemsUnder(lookup, found.entries, core, false),
      confidence: found.confidence,
    };
  }
  return found;
};

const resolveUnit = (options: ResolveOptions, unit: Unit): Candidates => {
  const { lookup, explicit } = options;
  switch (unit.kind) {
    case "annex": {
      const core = unit.token.core.toLowerCase();
      const ordinal = tokenOrdinal(unit.token);
      const annexes = lookup.index.entries.filter(
        (entry) =>
          entry.level === "annex" &&
          (entry.core === core ||
            (ordinal !== null && entry.ordinal === ordinal)),
      );
      const headings = annexes.filter((entry) => !entry.listed);
      return {
        entries: headings.length > 0 ? headings : annexes,
        confidence: explicit,
      };
    }
    case "recital": {
      const core = unit.token.core.toLowerCase();
      return {
        entries: lookup.index.entries.filter(
          (entry) => entry.level === "recital" && entry.core === core,
        ),
        confidence: explicit,
      };
    }
    case "article": {
      const ordinal = unit.article?.ordinal ?? null;
      const articles = bodyEntries(lookup, "article").filter(
        (entry) => ordinal !== null && entry.ordinal === ordinal,
      );
      // `čl. 11` under a heading printed `Článek XI.` names the same
      // article in other words; the field could not reproduce the text.
      const sameNumerals = articles.filter(
        (entry) =>
          (entry.shape.numeral === "decimal") ===
          (unit.token.family === "decimal"),
      );
      return sameNumerals.length > 0
        ? { entries: sameNumerals, confidence: explicit }
        : { entries: articles, confidence: CONFIDENCE.fallback };
    }
    case "clause":
      return unit.clausePath === null
        ? NONE
        : resolveClause(options, unit, unit.clausePath);
    case "item":
      return resolveItem(options, unit);
    default: {
      unit.kind satisfies never;
      return panic("Unhandled kind");
    }
  }
};

/** In a document of parallel columns a reference means the provision of
 *  its own column: the English text cites the English article. */
const inColumn = (
  candidates: Candidates,
  column: number | undefined,
): Candidates => {
  if (column === undefined) {
    return candidates;
  }
  const own = candidates.entries.filter((entry) => entry.column === column);
  return own.length > 0 ? { ...candidates, entries: own } : candidates;
};

const unitLevel = (
  unit: Unit,
  resolved: LabelEntry | undefined,
): LabelLevel => {
  if (resolved !== undefined) {
    return resolved.level;
  }
  if (unit.kind !== "item") {
    return unit.kind;
  }
  const core = unit.items.at(-1) ?? "";
  return core.length > 1 && parseRomanNumeral(core) !== null
    ? "roman"
    : "letter";
};

const toResolution = (
  { entries, confidence }: Candidates,
  cap: number,
): ReferenceResolution => {
  const [only, ...others] = entries;
  if (only === undefined) {
    return { status: "unresolved", reason: "missingTarget" };
  }
  if (others.length === 0) {
    return {
      status: "resolved",
      targetBlockId: only.blockId,
      confidence: Math.min(confidence, cap),
    };
  }
  const share = CONFIDENCE.ambiguousTotal / entries.length;
  return {
    status: "ambiguous",
    candidates: entries.map((entry) => ({
      targetBlockId: entry.blockId,
      confidence: Math.min(confidence, share),
    })),
  };
};

const EXTERNAL_EVIDENCE = [
  "statuteName",
  "abbreviation",
  "namedDocument",
] as const satisfies readonly ReferenceEvidence[];

type Resolved = { unit: Unit; candidates: Candidates };

const isDroppable = ({ unit, candidates }: Resolved): boolean =>
  unit.token.join === "list" &&
  !unit.token.attached &&
  unit.token.family === "decimal" &&
  candidates.entries.length === 0;

type Scope = Pick<DetectedReference, "scope" | "confidence">;

const decideScope = (
  evidence: readonly ReferenceEvidence[],
  resolved: readonly Resolved[],
  /** `bod 3`, `item 3`: the head names no level, and counts things other
   *  than provisions too. */
  pointOnly: boolean,
): Scope => {
  const has = (code: ReferenceEvidence) => evidence.includes(code);
  const anyResolved = resolved.some(
    ({ candidates }) => candidates.entries.length > 0,
  );
  if (has("statuteName")) {
    return { scope: "external", confidence: CONFIDENCE.statute };
  }
  if (has("abbreviation")) {
    return { scope: "external", confidence: CONFIDENCE.abbreviation };
  }
  if (has("namedDocument")) {
    // The document may be named the way it names itself; a chain that
    // resolves here is the model's to decide.
    return anyResolved
      ? { scope: "unknown", confidence: CONFIDENCE.unknown }
      : { scope: "external", confidence: CONFIDENCE.namedDocument };
  }
  if (has("sectionSign")) {
    return { scope: "external", confidence: CONFIDENCE.sectionSign };
  }
  if (has("selfDeictic")) {
    return { scope: "internal", confidence: CONFIDENCE.selfDeictic };
  }
  if (has("relativeDeictic")) {
    return { scope: "internal", confidence: CONFIDENCE.relativeDeictic };
  }
  if (has("ownNoun")) {
    return { scope: "internal", confidence: CONFIDENCE.ownNoun };
  }
  return anyResolved && !pointOnly
    ? { scope: "internal", confidence: CONFIDENCE.ownNumbering }
    : { scope: "unknown", confidence: CONFIDENCE.unknown };
};

type ReadOptions = {
  block: DocxBlock;
  lookup: Lookup;
  context: BlockContext;
};

const toReference = (
  { block, lookup, context }: ReadOptions,
  chain: Chain,
): DetectedReference | null => {
  const { tail } = chain;
  const evidence: ReferenceEvidence[] = [...tail.evidence];
  const usesSign = chain.segments.some(({ level }) => level === "section");
  const pointsHome =
    evidence.includes("selfDeictic") || evidence.includes("relativeDeictic");
  if (usesSign && !lookup.index.usesSectionSign && !pointsHome) {
    evidence.push("sectionSign");
  }
  const external = EXTERNAL_EVIDENCE.some((code) => evidence.includes(code));
  const options: ResolveOptions = {
    lookup,
    context,
    explicit: evidence.includes("selfDeictic")
      ? CONFIDENCE.selfDeictic
      : CONFIDENCE.explicit,
    relative:
      tail.relative === null
        ? CONFIDENCE.relativeImplicit
        : CONFIDENCE.relativeDeictic,
    ownArticle: tail.relative === "article",
  };
  const column = lookup.index.columnByBlockId.get(block.id);
  let resolved: Resolved[] = buildUnits(chain.segments).map((unit) => ({
    unit,
    candidates:
      unit.annex !== null && unit.kind !== "annex"
        ? NONE
        : inColumn(resolveUnit(options, unit), column),
  }));
  let { end } = chain;
  // `čl. 5 a 10 dnů`: a number after a conjunction that names no provision
  // was never part of the chain.
  // A chain that says whose provision it cites keeps every designator: a
  // number its document lacks is then a citation to report, not a count.
  const citesOwn = pointsHome || evidence.includes("ownNoun");
  if (!external && !citesOwn) {
    while (resolved.length > 1) {
      const last = resolved.at(-1);
      const before = resolved.at(-2);
      if (last === undefined || before === undefined || !isDroppable(last)) {
        break;
      }
      resolved = resolved.slice(0, -1);
      end = before.unit.token.end;
    }
  }
  const withinAnnex = resolved.some(
    ({ unit }) => unit.annex !== null && unit.kind !== "annex",
  );
  if (withinAnnex) {
    evidence.push("withinAnnex");
  }
  if (chain.loose) {
    // No question to ask when the document has no such article.
    if (resolved.every(({ candidates }) => candidates.entries.length === 0)) {
      return null;
    }
    evidence.push("looseHead");
  }
  const scope: Scope = chain.loose
    ? { scope: "unknown", confidence: CONFIDENCE.unknown }
    : decideScope(
        evidence,
        resolved,
        chain.segments.every(({ level }) => level === "point"),
      );
  if (
    scope.scope === "internal" &&
    resolved.every(({ candidates }) => candidates.entries.length === 1)
  ) {
    evidence.push("ownNumbering");
  }
  return {
    id: `${block.id}:${String(chain.start)}`,
    blockId: block.id,
    start: chain.start,
    end,
    ...scope,
    evidence,
    designators: resolved.map(({ unit, candidates }) => {
      const { token } = unit;
      let resolution: ReferenceResolution;
      if (scope.scope === "external") {
        resolution = { status: "skipped" };
      } else if (unit.annex !== null && unit.kind !== "annex") {
        resolution = { status: "unresolved", reason: "withinAnnex" };
      } else {
        resolution = toResolution(
          candidates,
          token.join === "list" && !token.attached ? CONFIDENCE.listed : 1,
        );
      }
      return {
        start: token.start,
        end: token.end,
        level: unitLevel(
          unit,
          candidates.entries.length === 1
            ? candidates.entries.at(0)
            : undefined,
        ),
        join: token.join,
        resolution,
      };
    }),
  };
};

const collectAmbiguities = (
  references: readonly DetectedReference[],
): ReferenceAmbiguity[] =>
  references.flatMap((reference): ReferenceAmbiguity[] => {
    const targets = reference.designators.flatMap(
      ({ resolution }, designatorIndex): ReferenceAmbiguity[] =>
        resolution.status === "ambiguous"
          ? [
              {
                kind: "target",
                referenceId: reference.id,
                designatorIndex,
                candidates: resolution.candidates,
              },
            ]
          : [],
    );
    const resolvable = reference.designators.some(
      ({ resolution }) =>
        resolution.status === "resolved" || resolution.status === "ambiguous",
    );
    return reference.scope === "unknown" && resolvable
      ? [
          {
            kind: "scope",
            referenceId: reference.id,
            options: ["internal", "external"],
          },
          ...targets,
        ]
      : targets;
  });

const EMPTY_CONTEXT: BlockContext = {
  articleBlockId: null,
  clauseBlockId: null,
  itemBlockId: null,
  annexBlockId: null,
};

/**
 * Detects the cross-references of every paragraph. Pass the index when the
 * caller already built one; the two must come from the same manifest.
 */
export const detectReferences = (
  manifest: Pick<DocxBlockManifest, "blocks">,
  index: LabelIndex = buildLabelIndex(manifest),
): ReferenceDetection => {
  const childrenByParent = new Map<string, LabelEntry[]>();
  for (const entry of index.entries) {
    if (entry.parentBlockId === null) {
      continue;
    }
    const siblings = childrenByParent.get(entry.parentBlockId);
    if (siblings === undefined) {
      childrenByParent.set(entry.parentBlockId, [entry]);
    } else {
      siblings.push(entry);
    }
  }
  const lookup: Lookup = { index, childrenByParent };
  const references = manifest.blocks.flatMap((block) => {
    if (block.kind !== "paragraph" || index.contentsBlockIds.has(block.id)) {
      return [];
    }
    // A heading's own typed label is not a reference to itself.
    // A heading's own label is no citation, also where the heading has no
    // entry because it counts the articles of a part of its own.
    const from =
      index.entryByBlockId.get(block.id)?.manualLength ??
      index.ownLabelLengths.get(block.id) ??
      0;
    const context = index.contextByBlockId.get(block.id) ?? EMPTY_CONTEXT;
    return readChains(block.text, from).flatMap((chain) => {
      const reference = toReference({ block, lookup, context }, chain);
      return reference === null ? [] : [reference];
    });
  });
  const settled = [
    ...references.map((reference) =>
      settledBySourceFields(reference, manifest.blocks, index),
    ),
    ...fieldsReadAsNone(manifest.blocks, references, index),
  ].toSorted(byPlaceIn(manifest.blocks));
  return {
    references: settled,
    ambiguities: collectAmbiguities(settled),
  };
};

/**
 * The source's own fields to a numbered provision that no chain was read
 * over: a bare number of a list the drafter linked (`Sections 2.1, 2.10,
 * [3.1, 3.2]`). Each is a citation of its target as the field shows it;
 * whether a field of the output can show the same is the plan's to say.
 */
const fieldsReadAsNone = (
  blocks: readonly DocxBlock[],
  references: readonly DetectedReference[],
  index: LabelIndex,
): DetectedReference[] =>
  blocks.flatMap((block) => {
    if (block.crossReferences === undefined) {
      return [];
    }
    const read = references.filter(({ blockId }) => blockId === block.id);
    return block.crossReferences.flatMap(
      ({ start, end, targetBlockId }): DetectedReference[] => {
        const entry =
          targetBlockId === null
            ? undefined
            : index.entryByBlockId.get(targetBlockId);
        const overlaps = read.some(
          (reference) => reference.start < end && start < reference.end,
        );
        if (
          entry === undefined ||
          targetBlockId === null ||
          overlaps ||
          block.text.slice(start, end).trim() === ""
        ) {
          return [];
        }
        return [
          {
            id: `${block.id}:${String(start)}`,
            blockId: block.id,
            start,
            end,
            scope: "internal",
            confidence: CONFIDENCE.sourceField,
            evidence: ["sourceField"],
            designators: [
              {
                start,
                end,
                level: entry.level,
                join: null,
                resolution: {
                  status: "resolved",
                  targetBlockId,
                  confidence: CONFIDENCE.sourceField,
                },
              },
            ],
          },
        ];
      },
    );
  });

/** Document order: by block, then by place in the block. */
const byPlaceIn = (
  blocks: readonly DocxBlock[],
): ((left: DetectedReference, right: DetectedReference) => number) => {
  const order = new Map(blocks.map(({ id }, position) => [id, position]));
  const at = (blockId: string): number => order.get(blockId) ?? -1;
  return (left, right) =>
    left.blockId === right.blockId
      ? left.start - right.start
      : at(left.blockId) - at(right.blockId);
};

/** The block and every provision it stands in, nearest first. */
const lineageOf = (blockId: string, index: LabelIndex): Set<string> => {
  const lineage = new Set<string>();
  let current: string | null = blockId;
  while (current !== null && !lineage.has(current)) {
    lineage.add(current);
    current = index.entryByBlockId.get(current)?.parentBlockId ?? null;
  }
  return lineage;
};

/**
 * A chain read as naming another document whose every designator the source
 * holds in a field to a provision of this one (`clause 30 of the Core
 * Terms`, where the Core Terms are part of the file): the drafter linked it
 * here. The last designator of a field means the field's target; one in
 * front of it the provision of its level the target stands in. Null where a
 * designator is outside every field or no provision of its level is found.
 */
const linkedByDrafter = (
  reference: DetectedReference,
  fields: readonly NonNullable<DocxBlock["crossReferences"]>[number][],
  index: LabelIndex,
): DetectedReference | null => {
  const designators: ReferenceDesignator[] = [];
  for (const designator of reference.designators) {
    const field = fields.find(
      ({ start, end }) => start <= designator.start && designator.end <= end,
    );
    if (field === undefined) {
      return null;
    }
    if (field.targetBlockId === null) {
      return null;
    }
    const last = !reference.designators.some(
      (other) =>
        other.start > designator.start &&
        field.start <= other.start &&
        other.end <= field.end,
    );
    const meant = last
      ? field.targetBlockId
      : ([...lineageOf(field.targetBlockId, index)].find(
          (blockId) =>
            index.entryByBlockId.get(blockId)?.level === designator.level,
        ) ?? null);
    if (meant === null) {
      return null;
    }
    designators.push({
      ...designator,
      resolution: {
        status: "resolved",
        targetBlockId: meant,
        confidence: CONFIDENCE.sourceField,
      },
    });
  }
  return {
    ...reference,
    scope: "internal",
    confidence: CONFIDENCE.sourceField,
    evidence: [...reference.evidence, "sourceField"],
    designators,
  };
};

/**
 * A reference the source holds as a field of its own: the field names the
 * provision the citation means. A designator inside the field that the rules
 * could not settle takes the one candidate that is the field's target or a
 * provision the target stands in (`1.2` of a field to `1.2(c)`), and the
 * chain reads as internal.
 */
const settledBySourceFields = (
  reference: DetectedReference,
  blocks: readonly DocxBlock[],
  index: LabelIndex,
): DetectedReference => {
  const held = blocks.find(
    ({ id }) => id === reference.blockId,
  )?.crossReferences;
  const fields =
    held === undefined
      ? []
      : held.filter(({ targetBlockId }) => targetBlockId !== null);
  if (fields.length === 0) {
    return reference;
  }
  if (reference.scope === "external") {
    return linkedByDrafter(reference, fields, index) ?? reference;
  }
  const designators = reference.designators.map((designator) => {
    const field = fields.find(
      ({ start, end }) => start <= designator.start && designator.end <= end,
    );
    if (field?.targetBlockId === null || field === undefined) {
      return designator;
    }
    const lineage = lineageOf(field.targetBlockId, index);
    const { resolution } = designator;
    const candidates =
      resolution.status === "ambiguous"
        ? resolution.candidates.map(({ targetBlockId }) => targetBlockId)
        : [];
    const meant = candidates.filter((candidate) => lineage.has(candidate));
    const [only] = meant;
    if (only === undefined || meant.length > 1) {
      return designator;
    }
    return {
      ...designator,
      resolution: {
        status: "resolved" as const,
        targetBlockId: only,
        confidence: CONFIDENCE.sourceField,
      },
    };
  });
  const covered = reference.designators.some((designator) =>
    fields.some(
      ({ start, end }) => start <= designator.start && designator.end <= end,
    ),
  );
  const settledAny = designators.some(
    (designator, position) => designator !== reference.designators[position],
  );
  const internal = covered && reference.scope === "unknown";
  if (!settledAny && !internal) {
    return reference;
  }
  return {
    ...reference,
    ...(internal
      ? { scope: "internal" as const, confidence: CONFIDENCE.sourceField }
      : {}),
    evidence: [...reference.evidence, "sourceField"],
    designators,
  };
};
