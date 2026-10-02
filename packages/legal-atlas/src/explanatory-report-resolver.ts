import { panic } from "better-result";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { formatProvisionKey } from "@stll/api-contract/provision-key";
import type { ProvisionRef } from "@stll/api-contract/provision-key";
import type { ProvisionReference } from "@stll/legal-ast/provision-reference";
import type { StatuteAst, StatuteBlock } from "@stll/legal-ast/statute-ast";

import {
  alignAmendmentPoints,
  parseAmendmentInstruction,
} from "./amendment-instruction";
import type {
  AmendmentAlignment,
  AmendmentPoint,
} from "./amendment-instruction";
import {
  MAX_EXPLANATORY_TARGETS,
  parseExplanatoryHeading,
  readExplanatoryValues,
} from "./explanatory-report-heading";
import type { ExplanatoryHeadingTarget } from "./explanatory-report-heading";
import {
  explanatoryPattern,
  EXPLANATORY_REPORT_PROFILES,
} from "./explanatory-report-profile";
import type {
  ExplanatoryReportProfile,
  ExplanatoryStructure,
} from "./explanatory-report-profile";
import { PROVISION_CITATION_GRAMMARS } from "./provision-citation-grammars";
import type {
  ProvisionLevelKey,
  SupportedProvisionCitationGrammar,
} from "./provision-citation-grammars";
import { provisionRefOf } from "./provision-key";
import type { SupportedProvisionJurisdiction } from "./provision-key";

type Reference = ProvisionRef<SupportedProvisionJurisdiction>;
export type IntroducedVersionWindow =
  | { status: "versioned"; validFrom: string; validTo: string | null }
  | { status: "unversioned" };
export type ExplanatoryScope =
  | { type: "work"; workIdentifier: string }
  | {
      type: "amendment";
      article: string | null;
      numbering: "bill" | "enacted";
    };
type BlockFields = { id: string; heading: string; scope: ExplanatoryScope };
export type PendingExplanatoryBlock = BlockFields & { status: "pending" };
export type ExplanatorySelection =
  | { type: "direct_heading" }
  | { type: "enacted_point"; pointId: string }
  | { type: "aligned_bill_point"; billPointId: string; enactedPointId: string };
export type ExplanatoryAttachment = {
  provision: Reference;
  level: ProvisionLevelKey;
  selection: ExplanatorySelection;
  introducedVersionWindow: IntroducedVersionWindow;
  amendingWorkIdentifier: string;
};
type FanOut = "single" | "grouped";
export type ExplanatoryBlockOutcome = BlockFields &
  (
    | {
        status: "resolved";
        fanOut: FanOut;
        attachments: readonly [
          ExplanatoryAttachment,
          ...ExplanatoryAttachment[],
        ];
      }
    | { status: "unresolved_anchor"; fanOut: FanOut; reason: string }
    | { status: "not_in_enacted_text"; fanOut: FanOut }
    | { status: "ambiguous"; fanOut: FanOut; reason: string }
  );
export type ExplanatoryBlockState =
  | PendingExplanatoryBlock
  | ExplanatoryBlockOutcome;

type IndexedProvision = {
  provision: Reference;
  storedAnchor: string;
  structures: readonly { kind: ExplanatoryStructure; designator: string }[];
};
type ExplanatoryWork = { workIdentifier: string; ast: StatuteAst };
const kindLevel = (
  kind: string,
  unit: ProvisionReference["unit"],
): ProvisionLevelKey | null => {
  if (kind === unit) {
    return "section";
  }
  switch (kind) {
    case "paragraph":
    case "subsection":
      return "subsection";
    case "letter":
      return "letter";
    case "point":
      return "point";
    default:
      return null;
  }
};
const referenceLevel = (reference: ProvisionReference): ProvisionLevelKey => {
  if (reference.point !== null) {
    return "point";
  }
  if (reference.letter !== null) {
    return "letter";
  }
  if (reference.subsection !== null) {
    return "subsection";
  }
  return "section";
};

type BlockReferenceOptions = {
  number: string | null;
  levelKey: ProvisionLevelKey;
  parent: ProvisionReference | null;
  profile: ExplanatoryReportProfile;
  unit: ProvisionReference["unit"];
};
const blockReference = ({
  number,
  levelKey,
  parent,
  profile,
  unit,
}: BlockReferenceOptions): ProvisionReference | null => {
  const level = profile.levels.find((entry) => entry.key === levelKey);
  if (level === undefined) {
    return panic("Missing explanatory provision level");
  }
  const text = (number ?? "")
    .replace(explanatoryPattern(`^(?:${level.marker})\\s*`, "iu"), "")
    .replace(/^\((.+)\)$/u, "$1")
    .trim();
  const parsed = readExplanatoryValues({ text, source: level.value, profile });
  const value = parsed?.values.at(0);
  if (
    value === undefined ||
    parsed?.end !== text.length ||
    parsed.values.length !== 1
  ) {
    return null;
  }
  if (levelKey === "section") {
    const section = /^(\d+)([a-z]?)$/u.exec(value);
    if (section === null) {
      return null;
    }
    return {
      unit,
      section: Number(section[1]),
      sectionSuffix: section[2] || null,
      subsection: null,
      letter: null,
      point: null,
      sentence: null,
      openEnded: false,
    };
  }
  if (parent === null) {
    return null;
  }
  if (levelKey === "subsection") {
    return {
      ...parent,
      subsection: value,
      letter: null,
      point: null,
      sentence: null,
    };
  }
  if (levelKey === "letter") {
    return { ...parent, letter: value, point: null, sentence: null };
  }
  return { ...parent, point: value, sentence: null };
};

type IndexWorkOptions = {
  work: ExplanatoryWork;
  jurisdiction: CaseLawJurisdiction;
  profile: ExplanatoryReportProfile;
};
const indexWork = ({
  work,
  jurisdiction,
  profile,
}: IndexWorkOptions): IndexedProvision[] => {
  const index: IndexedProvision[] = [];
  const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
  if (grammar.status === "unsupported") {
    return index;
  }
  const walk = (
    blocks: readonly StatuteBlock[],
    parent: ProvisionReference | null,
    structures: readonly { kind: ExplanatoryStructure; designator: string }[],
  ) => {
    for (const block of blocks) {
      switch (block.type) {
        case "provision": {
          let reference = parent;
          let containers = structures;
          if (block.kind === "part" || block.kind === "chapter") {
            containers = structures.filter(
              (structure) =>
                block.kind === "chapter" && structure.kind === "part",
            );
            const last = block.num?.trim().split(/\s+/u).at(-1) ?? "";
            const designator = readExplanatoryValues({
              text: last,
              source: String.raw`[\p{L}\p{M}\d]+`,
              profile,
              ordinal: true,
            });
            const value = designator?.values.at(0);
            if (value !== undefined && designator?.end === last.length) {
              containers = [
                ...containers,
                { kind: block.kind, designator: value },
              ];
            }
          }
          const levelKey = kindLevel(block.kind, grammar.unit);
          if (levelKey !== null) {
            reference = blockReference({
              number: block.num,
              levelKey,
              parent,
              profile,
              unit: grammar.unit,
            });
            if (reference !== null) {
              const constructed = provisionRefOf({
                jurisdiction,
                workIdentifier: work.workIdentifier,
                reference,
              });
              if (constructed.status === "resolved") {
                index.push({
                  provision: constructed.provision,
                  storedAnchor: block.anchorId,
                  structures: containers,
                });
              }
            }
          }
          // Article trees need an article grammar; descendants cannot inherit a section from outside that tree.
          if (
            (block.kind === "article" || block.kind === "section") &&
            block.kind !== grammar.unit
          ) {
            reference = null;
          }
          walk(block.children, reference, containers);
          break;
        }
        case "list":
          for (const item of block.items) {
            walk(item.children, parent, structures);
          }
          break;
        case "paragraph":
        case "table":
        case "footnote":
        case "edit":
          break;
        default:
          block satisfies never;
          return panic("Unhandled statute block");
      }
    }
  };
  walk(work.ast.body, null, []);
  return index;
};

type ResolveExplanatoryBlocksOptions = {
  jurisdiction: CaseLawJurisdiction;
  blocks: readonly ExplanatoryBlockState[];
  works: readonly ExplanatoryWork[];
  billPoints: readonly AmendmentPoint[];
  enactedPoints: readonly AmendmentPoint[];
  enactedCoverage: "complete" | "partial";
  amendingWorkIdentifier: string;
  introducedVersionWindow: IntroducedVersionWindow;
};

type Candidate = {
  workIdentifier: string;
  reference: ProvisionReference;
  selection: ExplanatorySelection;
};
type CandidateResult =
  | { status: "selected"; candidates: Candidate[]; fanOut: FanOut }
  | {
      status: "unresolved_anchor" | "ambiguous";
      reason: string;
      fanOut: FanOut;
    }
  | { status: "not_in_enacted_text"; fanOut: FanOut };
type ScopeIdentifierOptions = {
  scope: ExplanatoryScope;
  grammar: SupportedProvisionCitationGrammar;
  enactedPoints: readonly AmendmentPoint[];
  enactedCoverage: "complete" | "partial";
};
const scopeIdentifier = ({
  scope,
  grammar,
  enactedPoints,
  enactedCoverage,
}: ScopeIdentifierOptions): string | null => {
  if (scope.type === "work") {
    return grammar.gazette.parse(scope.workIdentifier)?.identifier ?? null;
  }
  if (enactedCoverage === "partial") {
    return null;
  }
  const identifiers = new Set<string>();
  for (const point of enactedPoints) {
    if (scope.article !== null && point.article !== scope.article) {
      continue;
    }
    const work = grammar.gazette.parse(point.workIdentifier);
    if (work === null) {
      return null;
    }
    identifiers.add(work.identifier);
  }
  return identifiers.size === 1 ? ([...identifiers].at(0) ?? null) : null;
};

type PointCandidatesOptions = {
  point: AmendmentPoint;
  numbering: "bill" | "enacted";
  alignment: readonly AmendmentAlignment[];
  jurisdiction: CaseLawJurisdiction;
};
const pointCandidates = ({
  point,
  numbering,
  alignment,
  jurisdiction,
}: PointCandidatesOptions): CandidateResult => {
  if (numbering === "bill") {
    const matches = alignment.filter((entry) => entry.billId === point.id);
    if (matches.length > 1)
      {return {
        status: "ambiguous",
        reason: "bill_point_identity",
        fanOut: "grouped",
      };}
    const aligned = matches.at(0);
    if (aligned === undefined) {
      return {
        status: "unresolved_anchor",
        reason: "bill_alignment_missing",
        fanOut: "single",
      };
    }
    switch (aligned.status) {
      case "not_in_enacted_text":
        return { status: "not_in_enacted_text", fanOut: "single" };
      case "ambiguous":
        return {
          status: "ambiguous",
          reason: "instruction_signature",
          fanOut: "grouped",
        };
      case "unresolved_anchor":
        return {
          status: "unresolved_anchor",
          reason: aligned.reason,
          fanOut: "single",
        };
      case "aligned":
        return {
          status: "selected",
          fanOut: aligned.instruction.targets.length > 1 ? "grouped" : "single",
          candidates: aligned.instruction.targets.map((reference) => ({
            workIdentifier: point.workIdentifier,
            reference,
            selection: {
              type: "aligned_bill_point",
              billPointId: point.id,
              enactedPointId: aligned.enactedId,
            },
          })),
        };
      default:
        aligned satisfies never;
        return panic("Unhandled amendment alignment");
    }
  }
  const instruction = parseAmendmentInstruction({
    text: point.text,
    jurisdiction,
    ...(point.context === undefined ? {} : { context: point.context }),
  });
  if (instruction.status === "unsupported") {
    return {
      status: "unresolved_anchor",
      reason: instruction.reason,
      fanOut: "single",
    };
  }
  return {
    status: "selected",
    fanOut: instruction.targets.length > 1 ? "grouped" : "single",
    candidates: instruction.targets.map((reference) => ({
      workIdentifier: point.workIdentifier,
      reference,
      selection: { type: "enacted_point", pointId: point.id },
    })),
  };
};

type AmendmentCandidatesOptions = {
  target: Extract<ExplanatoryHeadingTarget, { type: "amendment_points" }>;
  scope: ExplanatoryScope;
  billPoints: readonly AmendmentPoint[];
  enactedPoints: readonly AmendmentPoint[];
  enactedCoverage: "complete" | "partial";
  alignment: readonly AmendmentAlignment[];
  jurisdiction: CaseLawJurisdiction;
  grammar: SupportedProvisionCitationGrammar;
};
const amendmentCandidates = ({
  target,
  scope,
  billPoints,
  enactedPoints,
  enactedCoverage,
  alignment,
  jurisdiction,
  grammar,
}: AmendmentCandidatesOptions): CandidateResult => {
  const fanOut = target.points.length > 1 ? "grouped" : "single";
  const article =
    target.article ?? (scope.type === "amendment" ? scope.article : null);
  const numbering = scope.type === "amendment" ? scope.numbering : "enacted";
  const source = numbering === "bill" ? billPoints : enactedPoints;
  const scopeWork =
    scope.type === "work"
      ? grammar.gazette.parse(scope.workIdentifier)?.identifier
      : null;
  if (scope.type === "work" && scopeWork === undefined)
    {return { status: "unresolved_anchor", reason: "work_identifier", fanOut };}
  const candidates: Candidate[] = [];
  for (const number of target.points) {
    const matches = source.filter(
      (point) =>
        point.point === number &&
        (article === null || point.article === article) &&
        (scope.type !== "work" ||
          grammar.gazette.parse(point.workIdentifier)?.identifier ===
            scopeWork),
    );
    if (matches.length === 0) {
      if (numbering === "bill") {
        return {
          status: "unresolved_anchor",
          reason: "bill_point_missing",
          fanOut,
        };
      }
      if (enactedCoverage === "partial") {
        return {
          status: "unresolved_anchor",
          reason: "incomplete_enacted_points",
          fanOut,
        };
      }
      return { status: "not_in_enacted_text", fanOut };
    }
    if (matches.length > 1) {
      return { status: "ambiguous", reason: "point_scope", fanOut: "grouped" };
    }
    const point = matches.at(0);
    if (point === undefined) {
      return panic("Missing matched amendment point");
    }
    const selected = pointCandidates({
      point,
      numbering,
      alignment,
      jurisdiction,
    });
    if (selected.status !== "selected") {
      return {
        ...selected,
        fanOut: fanOut === "grouped" ? fanOut : selected.fanOut,
      };
    }
    candidates.push(...selected.candidates);
    if (candidates.length > MAX_EXPLANATORY_TARGETS) {
      return {
        status: "unresolved_anchor",
        reason: "expansion_limit",
        fanOut: "grouped",
      };
    }
  }
  return {
    status: "selected",
    candidates,
    fanOut: candidates.length > 1 ? "grouped" : fanOut,
  };
};

type HeadingCandidatesOptions = AmendmentCandidatesOptions & {
  indexes: ReadonlyMap<string, readonly IndexedProvision[]>;
  grammar: SupportedProvisionCitationGrammar;
};
type SelectHeadingOptions = Omit<HeadingCandidatesOptions, "target"> & {
  target: ExplanatoryHeadingTarget;
};
const headingCandidates = ({
  target,
  scope,
  indexes,
  grammar,
  ...points
}: SelectHeadingOptions): CandidateResult => {
  if (target.type === "amendment_points") {
    return amendmentCandidates({ target, scope, grammar, ...points });
  }
  const identifier = scopeIdentifier({
    scope,
    grammar,
    enactedPoints: points.enactedPoints,
    enactedCoverage: points.enactedCoverage,
  });
  if (identifier === null) {
    if (scope.type === "work") {
      return {
        status: "unresolved_anchor",
        reason: "work_identifier",
        fanOut: "single",
      };
    }
    return { status: "ambiguous", reason: "work_scope", fanOut: "single" };
  }
  if (target.type === "provisions") {
    return {
      status: "selected",
      fanOut: target.references.length > 1 ? "grouped" : "single",
      candidates: target.references.map((reference) => ({
        workIdentifier: identifier,
        reference,
        selection: { type: "direct_heading" },
      })),
    };
  }
  if (target.kind !== "part" && target.kind !== "chapter") {
    return {
      status: "unresolved_anchor",
      reason: `structural_${target.kind}`,
      fanOut: target.designators.length > 1 ? "grouped" : "single",
    };
  }
  const candidates: Candidate[] = [];
  for (const entry of indexes.get(identifier) ?? []) {
    if (
      entry.structures.some(
        (structure) =>
          structure.kind === target.kind &&
          target.designators.includes(structure.designator),
      )
    ) {
      candidates.push({
        workIdentifier: identifier,
        reference: entry.provision.reference,
        selection: { type: "direct_heading" },
      });
    }
    if (candidates.length > MAX_EXPLANATORY_TARGETS) {
      return {
        status: "unresolved_anchor",
        reason: "expansion_limit",
        fanOut: "grouped",
      };
    }
  }
  if (candidates.length === 0) {
    return {
      status: "unresolved_anchor",
      reason: "structural_anchor",
      fanOut: "grouped",
    };
  }
  return { status: "selected", candidates, fanOut: "grouped" };
};

type ConfirmCandidatesOptions = {
  selected: Extract<CandidateResult, { status: "selected" }>;
  jurisdiction: CaseLawJurisdiction;
  targetIndex: ReadonlyMap<string, readonly IndexedProvision[]>;
  introducedVersionWindow: IntroducedVersionWindow;
  amendingWorkIdentifier: string;
};
type ConfirmedCandidates =
  | {
      status: "resolved";
      fanOut: FanOut;
      attachments: readonly [ExplanatoryAttachment, ...ExplanatoryAttachment[]];
    }
  | Exclude<CandidateResult, { status: "selected" }>;
const confirmCandidates = ({
  selected,
  jurisdiction,
  targetIndex,
  introducedVersionWindow,
  amendingWorkIdentifier,
}: ConfirmCandidatesOptions): ConfirmedCandidates => {
  const { candidates, fanOut } = selected;
  if (candidates.length > MAX_EXPLANATORY_TARGETS) {
    return {
      status: "unresolved_anchor",
      reason: "expansion_limit",
      fanOut: "grouped",
    };
  }
  const attachments: ExplanatoryAttachment[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const constructed = provisionRefOf({
      jurisdiction,
      workIdentifier: candidate.workIdentifier,
      reference: candidate.reference,
    });
    if (constructed.status !== "resolved") {
      return {
        status: "unresolved_anchor",
        reason: constructed.status,
        fanOut,
      };
    }
    const { provision } = constructed;
    const key = formatProvisionKey(provision);
    const matches = targetIndex.get(key) ?? [];
    if (matches.length === 0) {
      return {
        status: "unresolved_anchor",
        reason: "ast_anchor_missing",
        fanOut,
      };
    }
    if (matches.length > 1) {
      return { status: "ambiguous", reason: "ast_anchor_duplicate", fanOut };
    }
    if (matches.at(0)?.storedAnchor !== provision.anchor) {
      return {
        status: "unresolved_anchor",
        reason: "ast_anchor_differs",
        fanOut,
      };
    }
    const attachmentKey = JSON.stringify([key, candidate.selection]);
    if (seen.has(attachmentKey)) {
      continue;
    }
    seen.add(attachmentKey);
    attachments.push({
      provision,
      level: referenceLevel(provision.reference),
      selection: candidate.selection,
      introducedVersionWindow,
      amendingWorkIdentifier,
    });
  }
  const first = attachments.at(0);
  if (first === undefined) {
    return { status: "unresolved_anchor", reason: "no_targets", fanOut };
  }
  return {
    status: "resolved",
    fanOut,
    attachments: [first, ...attachments.slice(1)],
  };
};

/** Every attachment requires a matching act/version and an unambiguous stored AST anchor. */
export const resolveExplanatoryBlocks = ({
  jurisdiction,
  blocks,
  works,
  billPoints,
  enactedPoints,
  enactedCoverage,
  amendingWorkIdentifier,
  introducedVersionWindow,
}: ResolveExplanatoryBlocksOptions): ExplanatoryBlockOutcome[] => {
  const profile = EXPLANATORY_REPORT_PROFILES[jurisdiction];
  const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
  const indexes = new Map<string, IndexedProvision[]>();
  const targetIndex = new Map<string, IndexedProvision[]>();
  if (profile.status === "supported" && grammar.status === "supported") {
    for (const work of works) {
      if (
        introducedVersionWindow.status === "versioned" &&
        (work.ast.metadata.validFrom !== introducedVersionWindow.validFrom ||
          work.ast.metadata.validTo !== introducedVersionWindow.validTo)
      ) {
        continue;
      }
      const identifier = grammar.gazette.parse(work.workIdentifier)?.identifier;
      if (
        identifier === undefined ||
        grammar.gazette.parse(work.ast.metadata.naturalId)?.identifier !==
          identifier
      ) {
        continue;
      }
      const entries = indexes.get(identifier) ?? [];
      for (const entry of indexWork({ work, jurisdiction, profile })) {
        entries.push(entry);
        const key = formatProvisionKey(entry.provision);
        const targets = targetIndex.get(key) ?? [];
        targets.push(entry);
        targetIndex.set(key, targets);
      }
      indexes.set(identifier, entries);
    }
  }
  const alignment = alignAmendmentPoints({
    jurisdiction,
    bill: billPoints,
    enacted: enactedPoints,
    enactedCoverage,
  });
  return blocks.map((block): ExplanatoryBlockOutcome => {
    if (block.status !== "pending") {
      return block;
    }
    const fields = { id: block.id, heading: block.heading, scope: block.scope };
    if (profile.status === "unsupported" || grammar.status === "unsupported") {
      return {
        ...fields,
        status: "unresolved_anchor",
        reason: "unsupported_jurisdiction",
        fanOut: "single",
      };
    }
    const amendingWork = grammar.gazette.parse(amendingWorkIdentifier);
    if (amendingWork === null) {
      return {
        ...fields,
        status: "unresolved_anchor",
        reason: "amending_work_identifier",
        fanOut: "single",
      };
    }
    const parsed = parseExplanatoryHeading(block.heading, jurisdiction);
    if (parsed.status === "unsupported") {
      return {
        ...fields,
        status: "unresolved_anchor",
        reason: parsed.reason,
        fanOut: "single",
      };
    }
    const selected = headingCandidates({
      target: parsed.target,
      scope: block.scope,
      grammar,
      indexes,
      billPoints,
      enactedPoints,
      enactedCoverage,
      alignment,
      jurisdiction,
    });
    if (selected.status !== "selected") {
      return { ...fields, ...selected };
    }
    return {
      ...fields,
      ...confirmCandidates({
        selected,
        jurisdiction,
        targetIndex,
        introducedVersionWindow,
        amendingWorkIdentifier: amendingWork.identifier,
      }),
    };
  });
};
