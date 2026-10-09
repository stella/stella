import { Result } from "better-result";
import * as v from "valibot";

export const STRUCTURED_OUTPUT_REPAIR_STEP = {
  EXTRACT_JSON: "extract-json",
  FILL_OPTIONAL_NOT_STATED: "fill-optional-not-stated",
  REMOVE_TRAILING_COMMAS: "remove-trailing-commas",
  SCALAR_COERCION: "scalar-coercion",
  UNWRAP_JSON_STRING: "unwrap-json-string",
} as const;

type RepairStep =
  (typeof STRUCTURED_OUTPUT_REPAIR_STEP)[keyof typeof STRUCTURED_OUTPUT_REPAIR_STEP];

export type StructuredOutputRepairResult<T> =
  | { type: "unchanged" }
  | { type: "repaired"; value: T; steps: readonly RepairStep[] }
  | { type: "unrepairable" };

const parseJson = (text: string) =>
  Result.try({
    try: (): unknown => JSON.parse(text),
    catch: (cause) => cause,
  });

const removeTrailingCommas = (text: string): string => {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      repaired += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      repaired += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/u.test(text[lookahead] ?? "")) {
        lookahead += 1;
      }
      if (text[lookahead] === "}" || text[lookahead] === "]") {
        continue;
      }
    }
    repaired += character;
  }
  return repaired;
};

const FENCED_JSON_PATTERN = /```(?:json)?\s*([\s\S]*?)```/giu;

const fencedCandidates = (text: string): string[] =>
  [...text.matchAll(FENCED_JSON_PATTERN)].map(
    (match) => match[1]?.trim() ?? "",
  );

const balancedCandidates = (text: string): string[] => {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if ((character === "}" || character === "]") && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
};

const scalarCandidates = (text: string): string[] => {
  const tokenPattern =
    /"(?:\\["\\/bfnrt]|\\u[\dA-Fa-f]{4}|[^"\\])*"|(?<![\w.])-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?(?![\w.])|(?<!\w)(?:true|false|null)(?!\w)/gu;
  return [...text.matchAll(tokenPattern)]
    .map((match) => match[0])
    .filter((candidate) => !Result.isError(parseJson(candidate)));
};

const extractCandidate = (text: string): string | null => {
  const fenced = fencedCandidates(text);
  if (fenced.length === 1) {
    const prose = text.replace(FENCED_JSON_PATTERN, "");
    const extraCandidates = [
      ...balancedCandidates(prose),
      ...scalarCandidates(prose),
    ];
    return extraCandidates.length === 0 ? (fenced[0] ?? null) : null;
  }
  if (fenced.length > 1) {
    return null;
  }
  const balanced = balancedCandidates(text);
  if (balanced.length > 0) {
    return balanced.length === 1 ? (balanced[0] ?? null) : null;
  }
  const scalars = scalarCandidates(text);
  return scalars.length === 1 ? (scalars[0] ?? null) : null;
};

const recordsDifferByMissingField = (
  input: unknown,
  output: unknown,
): boolean => {
  if (Array.isArray(input) && Array.isArray(output)) {
    return input.some((value, index) =>
      recordsDifferByMissingField(value, output[index]),
    );
  }
  if (
    input === null ||
    output === null ||
    typeof input !== "object" ||
    typeof output !== "object" ||
    Array.isArray(input) ||
    Array.isArray(output)
  ) {
    return false;
  }
  const inputRecord = Object.fromEntries(Object.entries(input));
  const outputRecord = Object.fromEntries(Object.entries(output));
  return Object.entries(outputRecord).some(
    ([key, value]) =>
      !(key in inputRecord) ||
      recordsDifferByMissingField(inputRecord[key], value),
  );
};

const hasScalarTypeChange = (input: unknown, output: unknown): boolean => {
  if (Array.isArray(input) && Array.isArray(output)) {
    return input.some((value, index) =>
      hasScalarTypeChange(value, output[index]),
    );
  }
  if (
    input !== null &&
    output !== null &&
    typeof input === "object" &&
    typeof output === "object" &&
    !Array.isArray(input) &&
    !Array.isArray(output)
  ) {
    const inputRecord = Object.fromEntries(Object.entries(input));
    const outputRecord = Object.fromEntries(Object.entries(output));
    return Object.keys(inputRecord).some(
      (key) =>
        key in outputRecord &&
        hasScalarTypeChange(inputRecord[key], outputRecord[key]),
    );
  }
  return typeof input !== typeof output;
};

export const repairStructuredOutput = <TSchema extends v.GenericSchema>(
  raw: string,
  schema: TSchema,
): StructuredOutputRepairResult<v.InferOutput<TSchema>> => {
  const original = parseJson(raw);
  if (!Result.isError(original)) {
    const parsed = v.safeParse(schema, original.value);
    if (parsed.success) {
      return { type: "unchanged" };
    }
  }

  const steps: RepairStep[] = [];
  let candidate = extractCandidate(raw) ?? raw.trim();
  if (candidate !== raw.trim()) {
    steps.push(STRUCTURED_OUTPUT_REPAIR_STEP.EXTRACT_JSON);
  }

  const withoutTrailingCommas = removeTrailingCommas(candidate);
  if (withoutTrailingCommas !== candidate) {
    candidate = withoutTrailingCommas;
    steps.push(STRUCTURED_OUTPUT_REPAIR_STEP.REMOVE_TRAILING_COMMAS);
  }

  let decoded = parseJson(candidate);
  if (Result.isError(decoded)) {
    return { type: "unrepairable" };
  }
  if (typeof decoded.value === "string") {
    const unwrapped = parseJson(decoded.value);
    if (!Result.isError(unwrapped)) {
      decoded = unwrapped;
      steps.push(STRUCTURED_OUTPUT_REPAIR_STEP.UNWRAP_JSON_STRING);
    }
  }

  if (steps.length === 0) {
    return { type: "unrepairable" };
  }
  const parsed = v.safeParse(schema, decoded.value);
  if (!parsed.success) {
    return { type: "unrepairable" };
  }
  if (hasScalarTypeChange(decoded.value, parsed.output)) {
    steps.push(STRUCTURED_OUTPUT_REPAIR_STEP.SCALAR_COERCION);
  }
  if (recordsDifferByMissingField(decoded.value, parsed.output)) {
    steps.push(STRUCTURED_OUTPUT_REPAIR_STEP.FILL_OPTIONAL_NOT_STATED);
  }
  return { type: "repaired", value: parsed.output, steps };
};
