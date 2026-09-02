import { RESERVED_FLAG_KEYS } from "./reserved-flag-keys.js";

const identity = (value: string): string => value;

type ParsedFlag = {
  readonly brief: string;
  readonly kind: "parsed";
  readonly optional: true;
  readonly parse: (value: string) => string;
};

type BooleanFlag = {
  readonly brief: string;
  readonly kind: "boolean";
  readonly optional: true;
  readonly withNegated: false;
};

type CommonFlags = {
  readonly output: ParsedFlag;
  readonly json: BooleanFlag;
  readonly table: BooleanFlag;
  readonly server: ParsedFlag;
};

const parsedStringFlag = (brief: string): ParsedFlag => ({
  brief,
  kind: "parsed",
  optional: true,
  parse: identity,
});

const booleanFlag = (brief: string): BooleanFlag => ({
  brief,
  kind: "boolean",
  optional: true,
  withNegated: false,
});

/**
 * `--server` on its own, for a command that has no output to format. The one
 * construction site for the flag, so its help text cannot drift per command.
 */
export const buildServerFlag = (): { readonly server: ParsedFlag } => ({
  [RESERVED_FLAG_KEYS.server]: parsedStringFlag(
    "Stella API origin for this command (default: STELLA_SERVER_URL, then the signed-in server)",
  ),
});

/**
 * The switches every command carries, whatever built it: generated tools,
 * generated capabilities, resources, and hand-authored commands. One
 * constructor makes `--json`/`--table`/`--output`/`--server` an all-command
 * invariant instead of a convention each custom command can silently miss.
 *
 * `--server` is parsed here only so the flag is accepted and documented
 * everywhere; its value is read out of argv before dispatch (`cli.ts`), since
 * the origin has to be resolved to build the context a command runs with.
 */
export const buildCommonFlags = (): CommonFlags => ({
  [RESERVED_FLAG_KEYS.output]: parsedStringFlag(
    "Output format: json | table | jsonl",
  ),
  [RESERVED_FLAG_KEYS.json]: booleanFlag("Output JSON (= --output json)"),
  [RESERVED_FLAG_KEYS.table]: booleanFlag("Output a table (= --output table)"),
  ...buildServerFlag(),
});

export type CommonFlagValues = {
  readonly json: boolean | undefined;
  readonly output: string | undefined;
  readonly server: string | undefined;
  readonly table: boolean | undefined;
};
