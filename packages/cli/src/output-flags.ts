import { RESERVED_FLAG_KEYS } from "./reserved-flag-keys.js";

const identity = (value: string): string => value;

type ParsedOutputFlag = {
  readonly brief: string;
  readonly kind: "parsed";
  readonly optional: true;
  readonly parse: (value: string) => string;
};

type BooleanOutputFlag = {
  readonly brief: string;
  readonly kind: "boolean";
  readonly optional: true;
  readonly withNegated: false;
};

type OutputFlags = {
  readonly output: ParsedOutputFlag;
  readonly json: BooleanOutputFlag;
  readonly table: BooleanOutputFlag;
};

const parsedStringFlag = (brief: string): ParsedOutputFlag => ({
  brief,
  kind: "parsed",
  optional: true,
  parse: identity,
});

const booleanFlag = (brief: string): BooleanOutputFlag => ({
  brief,
  kind: "boolean",
  optional: true,
  withNegated: false,
});

/**
 * The output switches shared by generated tools, generated capabilities,
 * resources, and hand-authored commands. Keeping one flag constructor makes
 * `--json`/`--table`/`--output` support an all-command invariant instead of a
 * convention each custom command can silently miss.
 */
export const buildOutputFlags = (): OutputFlags => ({
  [RESERVED_FLAG_KEYS.output]: parsedStringFlag(
    "Output format: json | table | jsonl",
  ),
  [RESERVED_FLAG_KEYS.json]: booleanFlag("Output JSON (= --output json)"),
  [RESERVED_FLAG_KEYS.table]: booleanFlag("Output a table (= --output table)"),
});

export type OutputFlagValues = {
  readonly json: boolean | undefined;
  readonly output: string | undefined;
  readonly table: boolean | undefined;
};
