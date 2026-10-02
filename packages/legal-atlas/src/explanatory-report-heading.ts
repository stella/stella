import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import type { ProvisionReference } from "@stll/legal-ast/provision-reference";

import {
  explanatoryPattern,
  EXPLANATORY_REPORT_PROFILES,
} from "./explanatory-report-profile";
import type {
  ExplanatoryReportProfile,
  ExplanatoryStructure,
} from "./explanatory-report-profile";
import { PROVISION_CITATION_GRAMMARS } from "./provision-citation-grammars";
import type { ProvisionLevelKey } from "./provision-citation-grammars";

export const MAX_EXPLANATORY_TARGETS = 256;
const MAX_HEADING_LENGTH = 4096;

export type ExplanatoryHeadingTarget =
  | { type: "provisions"; references: readonly ProvisionReference[] }
  | {
      type: "amendment_points";
      article: string | null;
      points: readonly number[];
    }
  | {
      type: "structure";
      kind: ExplanatoryStructure;
      designators: readonly string[];
    };
export type ExplanatoryHeading =
  | { status: "parsed"; target: ExplanatoryHeadingTarget }
  | {
      status: "unsupported";
      reason: "jurisdiction" | "heading" | "expansion_limit";
    };

export const normalizeExplanatoryText = (text: string): string =>
  text.replace(/\s+/gu, " ").trim();
type PatternAtOptions = { source: string; text: string; index: number };
const at = ({ source, text, index }: PatternAtOptions) =>
  new RegExp(`(?:${source})(?![\\p{L}\\p{M}\\p{N}])`, "yu").exec(
    text.slice(index),
  );
const markerAt = ({ source, text, index }: PatternAtOptions) =>
  explanatoryPattern(`(?:${source})(?![\\p{L}])`, "iyu").exec(
    text.slice(index),
  );
const matchStart = (source: string, text: string) =>
  explanatoryPattern(`^(?:${source})`, "iu").exec(text);
const skipSpace = (text: string, index: number) =>
  index + (text.slice(index).match(/^\s*/u)?.[0].length ?? 0);

/** Roman spellings are checked by re-encoding, so malformed additive forms never become identities. */
const romanNumber = (raw: string): number | null => {
  if (!/^[IVXLCDMivxlcdm]+$/u.test(raw)) {
    return null;
  }
  const parts = [
    [1000, "M"],
    [900, "CM"],
    [500, "D"],
    [400, "CD"],
    [100, "C"],
    [90, "XC"],
    [50, "L"],
    [40, "XL"],
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ] as const;
  const upper = raw.toUpperCase();
  let rest = upper;
  let number = 0;
  for (const [value, spelling] of parts) {
    while (rest.startsWith(spelling)) {
      number += value;
      rest = rest.slice(spelling.length);
    }
  }
  if (rest !== "" || number < 1 || number > 3999) {
    return null;
  }
  let remaining = number;
  let canonical = "";
  for (const [value, spelling] of parts) {
    while (remaining >= value) {
      remaining -= value;
      canonical += spelling;
    }
  }
  return canonical === upper ? number : null;
};

const canonicalValue = (
  raw: string,
  profile: ExplanatoryReportProfile,
  ordinal: boolean,
): string | null => {
  const value = raw.replace(/\)$/u, "").normalize("NFC").toLowerCase();
  if (!ordinal) {
    if (
      /^\d+$/u.test(value) &&
      (!Number.isSafeInteger(Number(value)) || Number(value) < 1)
    ) {
      return null;
    }
    return value.replace(/^0+(?=\d)/u, "");
  }
  const word = profile.ordinals[value];
  if (word !== undefined) {
    return String(word);
  }
  if (/^\d+$/u.test(value)) {
    return Number(value) > 0 ? String(Number(value)) : null;
  }
  const roman = romanNumber(value);
  return roman === null ? null : String(roman);
};

type ValuesResult = { values: string[]; end: number } | null;
/** Read a bounded list, leaving a connector before an explicit next level for the path reader. */
type ReadExplanatoryValuesOptions = {
  text: string;
  source: string;
  profile: ExplanatoryReportProfile;
  ordinal?: boolean;
};
export const readExplanatoryValues = ({
  text,
  source,
  profile,
  ordinal = false,
}: ReadExplanatoryValuesOptions): ValuesResult => {
  const values: string[] = [];
  let index = 0;
  while (index < text.length) {
    index = skipSpace(text, index);
    const value = at({ source, text, index });
    if (value === null) {
      return null;
    }
    const start = canonicalValue(value[0], profile, ordinal);
    if (start === null) {
      return null;
    }
    index += value[0].length;
    const rangeIndex = skipSpace(text, index);
    const range = matchStart(profile.range, text.slice(rangeIndex));
    if (range !== null) {
      index = skipSpace(text, rangeIndex + range[0].length);
      const end = at({ source, text, index });
      if (end === null) {
        return null;
      }
      const last = canonicalValue(end[0], profile, ordinal);
      if (last === null) {
        return null;
      }
      const numeric = /^\d+$/u.test(start) && /^\d+$/u.test(last);
      const letters = /^[a-z]$/u.test(start) && /^[a-z]$/u.test(last);
      if (!numeric && !letters) {
        return null;
      }
      const firstNumber = numeric ? Number(start) : start.codePointAt(0);
      const lastNumber = numeric ? Number(last) : last.codePointAt(0);
      if (
        firstNumber === undefined ||
        lastNumber === undefined ||
        lastNumber < firstNumber ||
        lastNumber - firstNumber + values.length >= MAX_EXPLANATORY_TARGETS
      ) {
        return null;
      }
      for (let n = firstNumber; n <= lastNumber; n++) {
        values.push(numeric ? String(n) : String.fromCodePoint(n));
      }
      index += end[0].length;
    } else {
      values.push(start);
    }
    if (values.length > MAX_EXPLANATORY_TARGETS) {
      return null;
    }
    const connectorIndex = skipSpace(text, index);
    const connector = matchStart(profile.connector, text.slice(connectorIndex));
    if (connector === null) {
      break;
    }
    const next = skipSpace(text, connectorIndex + connector[0].length);
    if (at({ source, text, index: next }) === null) {
      break;
    }
    index = next;
  }
  return values.length === 0 ? null : { values, end: index };
};

const referenceFromPath = (
  path: ReadonlyMap<ProvisionLevelKey, string>,
  unit: ProvisionReference["unit"],
): ProvisionReference | null => {
  const section = path.get("section")?.match(/^(\d+)([a-z]?)$/u);
  const number = Number(section?.[1]);
  if (
    section === null ||
    section === undefined ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    return null;
  }
  return {
    unit,
    section: number,
    sectionSuffix: section[2] || null,
    subsection: path.get("subsection") ?? null,
    letter: path.get("letter") ?? null,
    point: path.get("point") ?? null,
    sentence: null,
    openEnded: false,
  };
};

type ParseExplanatoryReferencesOptions = {
  text: string;
  profile: ExplanatoryReportProfile;
  unit: ProvisionReference["unit"];
};
export const parseExplanatoryReferences = ({
  text,
  profile,
  unit,
}: ParseExplanatoryReferencesOptions): ProvisionReference[] | null => {
  let paths = [new Map<ProvisionLevelKey, string>()];
  const finished: Map<ProvisionLevelKey, string>[] = [];
  let previousLevel = -1;
  let index = 0;
  while (index < text.length) {
    index = skipSpace(text, index);
    const markerIndex = index;
    const levelIndex = profile.levels.findIndex(
      (level) =>
        markerAt({ source: level.marker, text, index: markerIndex }) !== null,
    );
    const level = profile.levels.at(levelIndex);
    if (
      levelIndex === -1 ||
      level === undefined ||
      (previousLevel < 0 && level.key !== "section")
    ) {
      return null;
    }
    const marker = markerAt({ source: level.marker, text, index });
    if (marker === null) {
      return null;
    }
    index = skipSpace(text, index + marker[0].length);
    const parsed = readExplanatoryValues({
      text: text.slice(index),
      source: level.value,
      profile,
    });
    if (parsed === null) {
      return null;
    }
    if (levelIndex <= previousLevel) {
      finished.push(...paths);
      const parents = new Map<string, Map<ProvisionLevelKey, string>>();
      for (const path of paths) {
        const parent = new Map(
          [...path].filter(
            ([key]) =>
              profile.levels.findIndex((entry) => entry.key === key) <
              levelIndex,
          ),
        );
        parents.set(JSON.stringify([...parent]), parent);
      }
      paths = [...parents.values()];
    }
    if (
      paths.length * parsed.values.length + finished.length >
      MAX_EXPLANATORY_TARGETS
    ) {
      return null;
    }
    const expanded: Map<ProvisionLevelKey, string>[] = [];
    for (const path of paths) {
      for (const value of parsed.values) {
        expanded.push(new Map(path).set(level.key, value));
      }
    }
    paths = expanded;
    if (paths.length + finished.length > MAX_EXPLANATORY_TARGETS) {
      return null;
    }
    previousLevel = levelIndex;
    index = skipSpace(text, index + parsed.end);
    if (index === text.length) {
      break;
    }
    const connector = matchStart(profile.connector, text.slice(index));
    const nextMarkerIndex = index;
    if (connector !== null) {
      index = skipSpace(text, index + connector[0].length);
    } else if (
      profile.levels.findIndex(
        (entry) =>
          markerAt({ source: entry.marker, text, index: nextMarkerIndex }) !==
          null,
      ) <= levelIndex
    ) {
      return null;
    }
  }
  finished.push(...paths);
  const references: ProvisionReference[] = [];
  const seen = new Set<string>();
  for (const path of finished) {
    const reference = referenceFromPath(path, unit);
    if (reference === null) {
      return null;
    }
    const key = JSON.stringify(reference);
    if (!seen.has(key)) {
      references.push(reference);
      seen.add(key);
    }
  }
  return references.length === 0 ? null : references;
};

export const parseExplanatoryHeading = (
  heading: string,
  jurisdiction: CaseLawJurisdiction,
): ExplanatoryHeading => {
  const profile = EXPLANATORY_REPORT_PROFILES[jurisdiction];
  const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
  if (profile.status === "unsupported" || grammar.status === "unsupported") {
    return { status: "unsupported", reason: "jurisdiction" };
  }
  if (heading.length > MAX_HEADING_LENGTH) {
    return { status: "unsupported", reason: "expansion_limit" };
  }
  if (
    !heading.isWellFormed() ||
    /[\p{Cc}\p{Cf}]/u.test(heading.replace(/[\t\n\r]/gu, ""))
  ) {
    return { status: "unsupported", reason: "heading" };
  }
  const normalized = normalizeExplanatoryText(heading).replace(
    /\s+\([^()]*\)$/u,
    "",
  );
  const prefix = matchStart(profile.prefix, normalized);
  if (prefix === null) {
    return { status: "unsupported", reason: "heading" };
  }
  let text = normalized.slice(prefix[0].length);
  const references = parseExplanatoryReferences({
    text,
    profile,
    unit: grammar.unit,
  });
  if (references !== null) {
    return { status: "parsed", target: { type: "provisions", references } };
  }
  let article: string | null = null;
  const articleMarker = markerAt({ source: profile.article, text, index: 0 });
  if (articleMarker !== null) {
    const values = readExplanatoryValues({
      text: text.slice(articleMarker[0].length).trimStart(),
      source: String.raw`(?:[IVXLCDMivxlcdm]+|\d+)`,
      profile,
      ordinal: true,
    });
    if (values === null) {
      return { status: "unsupported", reason: "heading" };
    }
    const remainder = text
      .slice(articleMarker[0].length)
      .trimStart()
      .slice(values.end)
      .trim();
    if (remainder === "") {
      return {
        status: "parsed",
        target: {
          type: "structure",
          kind: "article",
          designators: values.values,
        },
      };
    }
    if (values.values.length !== 1) {
      return { status: "unsupported", reason: "heading" };
    }
    article = values.values.at(0) ?? null;
    text = remainder;
  }
  const pointMarker = markerAt({
    source: profile.amendmentPoint,
    text,
    index: 0,
  });
  if (pointMarker !== null) {
    const rest = text.slice(pointMarker[0].length).trimStart();
    const values = readExplanatoryValues({
      text: rest,
      source: String.raw`\d+`,
      profile,
    });
    if (
      values !== null &&
      rest.slice(values.end).trim() === "" &&
      values.values.every((value) => Number(value) > 0)
    ) {
      return {
        status: "parsed",
        target: {
          type: "amendment_points",
          article,
          points: values.values.map(Number),
        },
      };
    }
    return { status: "unsupported", reason: "heading" };
  }
  for (const structure of profile.structures) {
    const marker = markerAt({ source: structure.marker, text, index: 0 });
    if (marker === null) {
      continue;
    }
    const rest = text.slice(marker[0].length).trim();
    if (structure.value === "none") {
      return rest === ""
        ? {
            status: "parsed",
            target: {
              type: "structure",
              kind: structure.kind,
              designators: [],
            },
          }
        : { status: "unsupported", reason: "heading" };
    }
    const values = readExplanatoryValues({
      text: rest,
      source:
        structure.value === "ordinal"
          ? String.raw`[\p{L}\p{M}\d]+`
          : String.raw`\d+`,
      profile,
      ordinal: structure.value === "ordinal",
    });
    if (
      values !== null &&
      rest.slice(values.end).trim() === "" &&
      values.values.every((value) => Number(value) > 0)
    ) {
      return {
        status: "parsed",
        target: {
          type: "structure",
          kind: structure.kind,
          designators: values.values,
        },
      };
    }
  }
  return { status: "unsupported", reason: "heading" };
};

/** A full path for every target avoids inheriting scope from unrelated heading text. */
export const formatExplanatoryReferences = (
  references: readonly ProvisionReference[],
  jurisdiction: CaseLawJurisdiction,
): string | null => {
  const profile = EXPLANATORY_REPORT_PROFILES[jurisdiction];
  const grammar = PROVISION_CITATION_GRAMMARS[jurisdiction];
  if (
    profile.status === "unsupported" ||
    grammar.status === "unsupported" ||
    references.length === 0
  ) {
    return null;
  }
  const paths: string[] = [];
  for (const reference of references) {
    const normalized = grammar.normalizeReference(reference);
    if (
      normalized === null ||
      normalized.sentence !== null ||
      normalized.openEnded
    ) {
      return null;
    }
    const parts: string[] = [];
    for (const level of profile.levels) {
      const value =
        level.key === "section"
          ? `${normalized.section}${normalized.sectionSuffix ?? ""}`
          : normalized[level.key];
      if (value !== null) {
        parts.push(
          `${level.print} ${value}${level.key === "letter" ? ")" : ""}`,
        );
      }
    }
    paths.push(parts.join(" "));
  }
  return `${profile.printPrefix}${paths.join(", ")}`;
};
