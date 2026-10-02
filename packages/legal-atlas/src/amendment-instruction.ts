import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type { ProvisionReference } from "@stll/legal-ast/provision-reference";

import {
  MAX_EXPLANATORY_TARGETS,
  parseExplanatoryReferences,
  readExplanatoryValues,
} from "./explanatory-report-heading";
import {
  AMENDMENT_OPERATIONS,
  explanatoryPattern,
  EXPLANATORY_REPORT_PROFILES,
} from "./explanatory-report-profile";
import type {
  AmendmentOperation,
  ExplanatoryReportProfile,
} from "./explanatory-report-profile";
import { PROVISION_CITATION_GRAMMARS } from "./provision-citation-grammars";

export type ParsedAmendmentInstruction = {
  status: "parsed";
  targets: readonly ProvisionReference[];
  operations: readonly AmendmentOperation[];
  quotes: readonly string[];
  renumbering: readonly { from: ProvisionReference; to: ProvisionReference }[];
  /** Full instruction text prevents equal display numbers from establishing correspondence. */
  signature: string;
};
export type AmendmentInstruction =
  | ParsedAmendmentInstruction
  | {
      status: "unsupported";
      reason: "jurisdiction" | "instruction" | "context_required";
    };

const normalizeInstruction = (
  text: string,
  profile: ExplanatoryReportProfile,
): string | null => {
  const parts: string[] = [];
  let index = 0;
  let outside = 0;
  while (index < text.length) {
    const cursor = index;
    const pair = profile.quotes.find((quote) =>
      text.startsWith(quote.open, cursor),
    );
    if (pair === undefined) {
      if (
        profile.quotes.some((quote) => text.startsWith(quote.close, cursor))
      ) {
        return null;
      }
      index++;
      continue;
    }
    const end = text.indexOf(pair.close, index + pair.open.length);
    if (end === -1) {
      return null;
    }
    parts.push(text.slice(outside, index).replace(/\s+/gu, " "));
    parts.push(`"${text.slice(index + pair.open.length, end)}"`);
    index = end + pair.close.length;
    outside = index;
  }
  parts.push(text.slice(outside).replace(/\s+/gu, " "));
  return parts.join("").trim();
};

type ChildReferenceOptions = {
  parent: ProvisionReference;
  level: "subsection" | "letter" | "point";
  value: string;
};
const childReference = ({
  parent,
  level,
  value,
}: ChildReferenceOptions): ProvisionReference => {
  let letter = parent.letter;
  if (level === "subsection") {
    letter = null;
  }
  if (level === "letter") {
    letter = value;
  }
  return {
    unit: parent.unit,
    section: parent.section,
    sectionSuffix: parent.sectionSuffix,
    subsection: level === "subsection" ? value : parent.subsection,
    letter,
    point: level === "point" ? value : null,
    sentence: null,
    openEnded: false,
  };
};

type RenumberingOptions = {
  match: RegExpExecArray;
  profile: ExplanatoryReportProfile;
  context: ProvisionReference;
};
type RenumberedTargets = {
  targets: ProvisionReference[];
  renumbering: { from: ProvisionReference; to: ProvisionReference }[];
};
const renumberedTargets = ({
  match,
  profile,
  context,
}: RenumberingOptions): RenumberedTargets | null => {
  const level = profile.levels.find(
    (entry) =>
      entry.key !== "section" &&
      explanatoryPattern(`^(?:${entry.marker})$`, "iu").test(
        match.groups?.["level"] ?? "",
      ),
  );
  if (
    level === undefined ||
    level.key === "section" ||
    !explanatoryPattern(`^(?:${level.marker})$`, "iu").test(
      match.groups?.["toLevel"] ?? "",
    )
  ) {
    return null;
  }
  const fromText = match.groups?.["from"] ?? "";
  const toText = match.groups?.["to"] ?? "";
  const from = readExplanatoryValues({
    text: fromText,
    source: level.value,
    profile,
  });
  const to = readExplanatoryValues({
    text: toText,
    source: level.value,
    profile,
  });
  if (
    from === null ||
    to === null ||
    from.end !== fromText.length ||
    to.end !== toText.length ||
    from.values.length !== to.values.length
  ) {
    return null;
  }
  const targets: ProvisionReference[] = [];
  const renumbering: { from: ProvisionReference; to: ProvisionReference }[] =
    [];
  for (const [index, value] of from.values.entries()) {
    const destination = to.values.at(index);
    if (destination === undefined) {
      return null;
    }
    const target = childReference({
      parent: context,
      level: level.key,
      value: destination,
    });
    targets.push(target);
    renumbering.push({
      from: childReference({ parent: context, level: level.key, value }),
      to: target,
    });
  }
  return { targets, renumbering };
};

type InsertedTargetsOptions = {
  suffix: string;
  parents: readonly ProvisionReference[];
  profile: ExplanatoryReportProfile;
  unit: ProvisionReference["unit"];
};
const insertedTargets = ({
  suffix,
  parents,
  profile,
  unit,
}: InsertedTargetsOptions): ProvisionReference[] | null => {
  const beforeContent = suffix.split(/[,.:]/u).at(0)?.trim() ?? "";
  const sections = parseExplanatoryReferences({
    text: beforeContent,
    profile,
    unit,
  });
  if (sections !== null) {
    return sections;
  }
  const section = profile.levels.find((level) => level.key === "section");
  if (
    section !== undefined &&
    explanatoryPattern(`^(?:${section.marker})`, "u").test(suffix)
  ) {
    return null;
  }
  const child = profile.levels.find(
    (level) =>
      level.key !== "section" &&
      explanatoryPattern(`^(?:${level.marker})(?![\\p{L}])`, "iu").test(suffix),
  );
  if (child === undefined || child.key === "section") {
    return [...parents];
  }
  const marker = explanatoryPattern(`^(?:${child.marker})`, "iu").exec(suffix);
  if (marker === null) {
    return null;
  }
  const text = suffix.slice(marker[0].length).trim();
  const values = readExplanatoryValues({ text, source: child.value, profile });
  if (
    values === null ||
    !explanatoryPattern(profile.insertionTail, "u").test(
      text.slice(values.end).trim(),
    )
  ) {
    return null;
  }
  if (parents.length * values.values.length > MAX_EXPLANATORY_TARGETS) {
    return null;
  }
  const targets: ProvisionReference[] = [];
  for (const parent of parents) {
    for (const value of values.values) {
      targets.push(childReference({ parent, level: child.key, value }));
    }
  }
  return targets;
};

type OrdinaryTargetsOptions = {
  text: string;
  operations: readonly AmendmentOperation[];
  profile: ExplanatoryReportProfile;
  unit: ProvisionReference["unit"];
};
const ordinaryTargets = ({
  text,
  operations,
  profile,
  unit,
}: OrdinaryTargetsOptions): ProvisionReference[] | null => {
  if (operations.includes("renumber")) {
    return null;
  }
  const boundary = explanatoryPattern(profile.instructionBoundary, "iu").exec(
    text,
  );
  if (boundary === null) {
    return null;
  }
  const before = text
    .slice(0, boundary.index)
    .replace(explanatoryPattern(`^${profile.instructionPrefix}`, "iu"), "");
  const targets = parseExplanatoryReferences({ text: before, profile, unit });
  if (targets === null || !operations.includes("insert")) {
    return targets;
  }
  const insertion = explanatoryPattern(profile.operations.insert, "iu").exec(
    text.slice(boundary.index),
  );
  if (insertion === null) {
    return null;
  }
  const suffix = text
    .slice(boundary.index + insertion.index + insertion[0].length)
    .trim()
    .replace(explanatoryPattern(profile.insertedPrefix, "iu"), "");
  return insertedTargets({ suffix, parents: targets, profile, unit });
};

type ParseAmendmentInstructionOptions = {
  text: string;
  jurisdiction: CaseLawJurisdiction;
  context?: ProvisionReference;
};
export const parseAmendmentInstruction = ({
  text,
  jurisdiction,
  context,
}: ParseAmendmentInstructionOptions): AmendmentInstruction => {
  const profile = EXPLANATORY_REPORT_PROFILES[jurisdiction];
  const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
  if (profile.status === "unsupported" || grammar.status === "unsupported") {
    return { status: "unsupported", reason: "jurisdiction" };
  }
  if (
    text.length > 65_536 ||
    !text.isWellFormed() ||
    /[\p{Cc}\p{Cf}]/u.test(text.replace(/[\t\n\r]/gu, ""))
  ) {
    return { status: "unsupported", reason: "instruction" };
  }
  const normalizedText = normalizeInstruction(text, profile);
  if (normalizedText === null) {
    return { status: "unsupported", reason: "instruction" };
  }
  const normalized = normalizedText.replace(
    explanatoryPattern(profile.numberPrefix, "u"),
    "",
  );
  const quotes = [...normalized.matchAll(/"([^"]*)"/gu)].map(
    (match) => match[1] ?? "",
  );
  const operative =
    normalized
      .replace(/"[^"]*"/gu, "")
      .split(explanatoryPattern(profile.contentBoundary, "iu"))
      .at(0) ?? "";
  const operations = AMENDMENT_OPERATIONS.filter((operation) =>
    explanatoryPattern(profile.operations[operation], "iu").test(operative),
  );
  if (operations.length === 0) {
    return { status: "unsupported", reason: "instruction" };
  }
  const renumber = explanatoryPattern(profile.renumber, "iu").exec(normalized);
  let parsed: RenumberedTargets | null;
  if (renumber !== null) {
    if (context === undefined) {
      return { status: "unsupported", reason: "context_required" };
    }
    const parent = grammar.normalizeReference(context);
    if (parent === null) {
      return { status: "unsupported", reason: "instruction" };
    }
    parsed = renumberedTargets({ match: renumber, profile, context: parent });
  } else {
    const targets = ordinaryTargets({
      text: normalized,
      operations,
      profile,
      unit: grammar.unit,
    });
    parsed = targets === null ? null : { targets, renumbering: [] };
  }
  if (parsed === null || parsed.targets.length > MAX_EXPLANATORY_TARGETS) {
    return { status: "unsupported", reason: "instruction" };
  }
  const targets: ProvisionReference[] = [];
  for (const target of parsed.targets) {
    const reference = grammar.normalizeReference(target);
    if (reference === null) {
      return { status: "unsupported", reason: "instruction" };
    }
    targets.push(reference);
  }
  return {
    status: "parsed",
    targets,
    operations,
    quotes,
    renumbering: parsed.renumbering,
    signature: JSON.stringify([
      targets,
      operations,
      quotes,
      normalized.normalize("NFC"),
    ]),
  };
};

export type AmendmentPoint = {
  id: string;
  article: string;
  point: number;
  workIdentifier: string;
  text: string;
  context?: ProvisionReference;
};
export type AmendmentAlignment =
  | {
      status: "aligned";
      billId: string;
      enactedId: string;
      instruction: ParsedAmendmentInstruction;
    }
  | { status: "not_in_enacted_text"; billId: string }
  | { status: "ambiguous"; billId: string; enactedIds: readonly string[] }
  | { status: "unresolved_anchor"; billId: string; reason: string };

type AlignAmendmentPointsOptions = {
  bill: readonly AmendmentPoint[];
  enacted: readonly AmendmentPoint[];
  enactedCoverage: "complete" | "partial";
  jurisdiction: CaseLawJurisdiction;
};
export const alignAmendmentPoints = ({
  bill,
  enacted,
  enactedCoverage,
  jurisdiction,
}: AlignAmendmentPointsOptions): AmendmentAlignment[] => {
  const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
  const unparsedWorks = new Set<string>();
  let invalidEnactedWork = false;
  const index = new Map<
    string,
    { point: AmendmentPoint; instruction: ParsedAmendmentInstruction }[]
  >();
  for (const point of enacted) {
    const instruction = parseAmendmentInstruction({
      text: point.text,
      jurisdiction,
      ...(point.context === undefined ? {} : { context: point.context }),
    });
    const work =
      grammar.status === "supported"
        ? grammar.gazette.parse(point.workIdentifier)
        : null;
    if (work === null) {
      invalidEnactedWork = true;
      continue;
    }
    if (instruction.status !== "parsed") {
      unparsedWorks.add(work.identifier);
      continue;
    }
    const key = JSON.stringify([work.identifier, instruction.signature]);
    const entries = index.get(key) ?? [];
    entries.push({ point, instruction });
    index.set(key, entries);
  }
  return bill.map((point) => {
    const instruction = parseAmendmentInstruction({
      text: point.text,
      jurisdiction,
      ...(point.context === undefined ? {} : { context: point.context }),
    });
    const work =
      grammar.status === "supported"
        ? grammar.gazette.parse(point.workIdentifier)
        : null;
    if (instruction.status !== "parsed" || work === null) {
      return {
        status: "unresolved_anchor",
        billId: point.id,
        reason:
          instruction.status === "unsupported"
            ? instruction.reason
            : "work_identifier",
      };
    }
    if (invalidEnactedWork)
      {return {
        status: "unresolved_anchor",
        billId: point.id,
        reason: "invalid_enacted_work_identifier",
      };}
    if (enactedCoverage === "partial") {
      return {
        status: "unresolved_anchor",
        billId: point.id,
        reason: "incomplete_enacted_points",
      };
    }
    const matches =
      index.get(JSON.stringify([work.identifier, instruction.signature])) ?? [];
    if (unparsedWorks.has(work.identifier)) {
      return {
        status: "unresolved_anchor",
        billId: point.id,
        reason: "unparsed_enacted_instruction",
      };
    }
    if (matches.length === 0) {
      return { status: "not_in_enacted_text", billId: point.id };
    }
    if (matches.length > 1) {
      return {
        status: "ambiguous",
        billId: point.id,
        enactedIds: matches.map((entry) => entry.point.id),
      };
    }
    const match = matches.at(0);
    if (match === undefined) {
      return { status: "not_in_enacted_text", billId: point.id };
    }
    return {
      status: "aligned",
      billId: point.id,
      enactedId: match.point.id,
      instruction: match.instruction,
    };
  });
};
