import * as v from "valibot";

/**
 * What a chat step looked up and what came back, recorded by the server for
 * the person reading the step, never for the model.
 *
 * A code step (`execute_typescript`) runs a script whose return value is
 * whatever the model wrote, often a truncated string. The ledger is recorded
 * beside it from the reads themselves, one entry per read the script made,
 * so what the step shows never depends on what the script chose to return.
 * It rides on the step's stored output under `CHAT_STEP_LEDGER_KEY`, so the
 * live stream and a reload carry the same entries, and the provider copy of
 * every message drops it (`withoutChatStepLedger`), so the model reads what
 * it would read without one.
 */
export const CHAT_STEP_LEDGER_KEY = "stepLedger";

/**
 * How much one step keeps. Past `calls` a read is only counted
 * (`callsOmitted`), past `refsPerCall` a found item is only counted
 * (`foundOmitted`), and every query, label and title is cut at `textLength`.
 * A script may loop over hundreds of reads; a person reads a dozen.
 */
export const CHAT_STEP_LEDGER_LIMITS = {
  calls: 16,
  refsPerCall: 20,
  queriesPerCall: 5,
  filtersPerCall: 8,
  textLength: 240,
} as const;

/** Filters a read narrowed by, as the person would name them. */
export const CHAT_STEP_FILTER_KINDS = [
  "country",
  "court",
  "decisionType",
  "documentType",
  "status",
  "language",
  "dateFrom",
  "dateTo",
  "asOf",
] as const;
export type ChatStepFilterKind = (typeof CHAT_STEP_FILTER_KINDS)[number];

const boundedText = v.pipe(
  v.string(),
  v.maxLength(CHAT_STEP_LEDGER_LIMITS.textLength),
);
const nullableText = v.nullable(boundedText);

const chatStepFilterSchema = v.strictObject({
  kind: v.picklist(CHAT_STEP_FILTER_KINDS),
  value: boundedText,
});

/**
 * A found item, named the way chat names it in citations: a case-law
 * decision by its stella id and citation parts, a statute (or one provision
 * of it) by ELI and anchor with the version it was read in, and a matter
 * document or matter by its title.
 */
const chatStepRefSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("decision"),
    decisionId: boundedText,
    caseNumber: boundedText,
    court: boundedText,
    courtAbbreviation: nullableText,
    country: boundedText,
    decisionDate: nullableText,
    ecli: nullableText,
    /** The decision's headnote or popular name, one line. */
    summary: nullableText,
    /** The stella reader. */
    url: nullableText,
    /** The publisher's page. */
    sourceUrl: nullableText,
  }),
  v.strictObject({
    type: v.literal("statute"),
    eli: boundedText,
    /** The provision's publisher anchor; null for the whole act. */
    anchor: nullableText,
    /** The provision's printed citation, or the act's title. */
    label: boundedText,
    /** The first day of the version that was read. */
    validFrom: nullableText,
    validTo: nullableText,
    url: nullableText,
    sourceUrl: nullableText,
  }),
  // A matter item is named by its title alone. Tool results never carry a
  // tenant id (the model reads chat refs; the provider history redacts any
  // matter id), and the ledger rides on a tool result, so it carries none
  // either.
  v.strictObject({
    type: v.literal("document"),
    title: boundedText,
    kind: nullableText,
  }),
  v.strictObject({
    type: v.literal("matter"),
    title: boundedText,
  }),
]);

const countSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const chatStepCallSchema = v.strictObject({
  /** The read's registry name (`search_case_law`). */
  tool: boundedText,
  queries: v.pipe(
    v.array(boundedText),
    v.maxLength(CHAT_STEP_LEDGER_LIMITS.queriesPerCall),
  ),
  filters: v.pipe(
    v.array(chatStepFilterSchema),
    v.maxLength(CHAT_STEP_LEDGER_LIMITS.filtersPerCall),
  ),
  outcome: v.picklist(["ok", "error"]),
  found: v.pipe(
    v.array(chatStepRefSchema),
    v.maxLength(CHAT_STEP_LEDGER_LIMITS.refsPerCall),
  ),
  foundOmitted: countSchema,
});

export const chatStepLedgerSchema = v.strictObject({
  calls: v.pipe(
    v.array(chatStepCallSchema),
    v.maxLength(CHAT_STEP_LEDGER_LIMITS.calls),
  ),
  callsOmitted: countSchema,
});

export type ChatStepFilter = v.InferOutput<typeof chatStepFilterSchema>;
export type ChatStepRef = v.InferOutput<typeof chatStepRefSchema>;
export type ChatStepCall = v.InferOutput<typeof chatStepCallSchema>;
export type ChatStepLedger = v.InferOutput<typeof chatStepLedgerSchema>;
export type ChatStepCallOutcome = ChatStepCall["outcome"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The ledger a stored step output carries, or null when it carries none or
 * one this release cannot read. Stored output is untrusted at the page, so
 * it is parsed, never cast.
 */
export const readChatStepLedger = (output: unknown): ChatStepLedger | null => {
  if (!isRecord(output) || !Object.hasOwn(output, CHAT_STEP_LEDGER_KEY)) {
    return null;
  }
  const parsed = v.safeParse(
    chatStepLedgerSchema,
    output[CHAT_STEP_LEDGER_KEY],
  );
  return parsed.success ? parsed.output : null;
};

/**
 * `output` without its ledger: what the model reads of a step. Returns the
 * same value when there is no ledger, so callers can tell a change by
 * reference.
 */
export const withoutChatStepLedger = (output: unknown): unknown => {
  if (!isRecord(output) || !Object.hasOwn(output, CHAT_STEP_LEDGER_KEY)) {
    return output;
  }
  const { [CHAT_STEP_LEDGER_KEY]: _ledger, ...rest } = output;
  return rest;
};

/** The key's JSON spelling, for a cheap check before parsing tool content. */
export const CHAT_STEP_LEDGER_JSON_KEY = `"${CHAT_STEP_LEDGER_KEY}"`;
