import { panic } from "better-result";

import { isEntityKind } from "@stll/api-contract";
import { isCodeToolName } from "@stll/api-contract/chat-code-step";
import type { ChatReference } from "@stll/api-contract/chat-reference-href";
import { readChatStepLedger } from "@stll/api-contract/chat-step-ledger";
import type {
  ChatStepCall,
  ChatStepFilter,
  ChatStepLedger,
  ChatStepRef,
  ChatStepRefTarget,
} from "@stll/api-contract/chat-step-ledger";

import {
  type ChatAnswerCitations,
  collectExternalSources,
  type ExternalSourceEntry,
  sourceIsCited,
  stepRefSource,
} from "@/components/chat/source-chips.logic";

/**
 * What an opened step shows a person: what it looked up and what came back,
 * read from the step's ledger (`@stll/api-contract/chat-step-ledger`) and,
 * for a direct read with no ledger, from its own typed result. Never the
 * script or the raw result; those stay behind the technical details setting.
 */

/** One found item, with where it opens and whether the answer cites it. */
export type StepDigestRow = {
  key: string;
  ref: ChatStepRef;
  /** The source a citation opens it through; null when it opens nowhere. */
  source: ExternalSourceEntry | null;
  /**
   * A matter document or matter as the chat reference it opens as, from
   * the binding its message keeps for its chat ref; null for a public item
   * (it opens through `source`) or a ref the message does not bind.
   */
  reference: StepMatterReference | null;
  cited: boolean;
};

/** A found matter item as chat opens it: a document or a matter. */
export type StepMatterReference = Extract<
  ChatReference,
  { type: "entity" | "matter" }
>;

export type StepDigestCall = {
  key: string;
  tool: string;
  queries: readonly string[];
  filters: readonly ChatStepFilter[];
  outcome: ChatStepCall["outcome"];
  rows: readonly StepDigestRow[];
  /** Found items the ledger only counted. */
  omitted: number;
};

export type StepDigestCounts = {
  decisions: number;
  decisionsCited: number;
  legislation: number;
  documents: number;
  matters: number;
};

export type StepDigest = {
  calls: readonly StepDigestCall[];
  /** Reads the ledger only counted. */
  callsOmitted: number;
  counts: StepDigestCounts;
  /**
   * Whether the server recorded what each read found. A direct read's
   * digest names only the sources its result carries, so an empty one does
   * not mean nothing matched.
   */
  recorded: boolean;
};

/** A message's ref bindings, by chat ref. */
export type ChatStepRefTargets = ReadonlyMap<string, ChatStepRefTarget>;

/** For a step outside any stored message: no ref opens anything. */
export const NO_STEP_REF_TARGETS: ChatStepRefTargets = new Map();

/** The parts of a call a digest reads; its input and output are untrusted. */
type StepToolPart = { input: unknown; name: string; output: unknown };

/** The ledger a step carries, for a code step; null for any other step. */
const stepLedgerOf = (part: StepToolPart): ChatStepLedger | null =>
  isCodeToolName(part.name) ? readChatStepLedger(part.output) : null;

const refKey = (ref: ChatStepRef): string => {
  switch (ref.type) {
    case "decision":
      return `decision:${ref.decisionId}`;
    case "statute":
      return `statute:${ref.eli}#${ref.anchor ?? ""}@${ref.validFrom ?? ""}`;
    // A chat ref names one item in its thread, however many share a title.
    case "document":
      return `document:${ref.ref}`;
    case "matter":
      return `matter:${ref.ref}`;
    default:
      ref satisfies never;
      return panic("Unhandled step ledger item");
  }
};

/** Where a found matter item opens, by the binding of its chat ref. */
const matterReference = (
  ref: ChatStepRef,
  targets: ChatStepRefTargets,
): StepMatterReference | null => {
  switch (ref.type) {
    case "decision":
    case "statute":
      return null;
    case "document": {
      const target = targets.get(ref.ref);
      return target?.type === "document"
        ? {
            type: "entity",
            entityId: target.entityId,
            matterId: target.matterId,
            label: ref.title,
            entityKind: isEntityKind(ref.kind) ? ref.kind : null,
            mimeType: null,
          }
        : null;
    }
    case "matter": {
      const target = targets.get(ref.ref);
      return target?.type === "matter"
        ? { type: "matter", matterId: target.matterId, label: ref.title }
        : null;
    }
    default:
      ref satisfies never;
      return panic("Unhandled step ledger item");
  }
};

const digestRows = (
  refs: readonly ChatStepRef[],
  citations: ChatAnswerCitations,
  targets: ChatStepRefTargets,
): StepDigestRow[] =>
  refs.map((ref) => {
    const source = stepRefSource(ref);
    return {
      key: refKey(ref),
      ref,
      source,
      reference: matterReference(ref, targets),
      cited: source !== null && sourceIsCited(source, citations),
    };
  });

const countsOf = (calls: readonly StepDigestCall[]): StepDigestCounts => {
  const seen = new Map<string, StepDigestRow>();
  for (const call of calls) {
    for (const row of call.rows) {
      seen.set(row.key, row);
    }
  }
  const rows = [...seen.values()];
  const decisions = rows.filter((row) => row.ref.type === "decision");
  return {
    decisions: decisions.length,
    decisionsCited: decisions.filter((row) => row.cited).length,
    legislation: rows.filter((row) => row.ref.type === "statute").length,
    documents: rows.filter((row) => row.ref.type === "document").length,
    matters: rows.filter((row) => row.ref.type === "matter").length,
  };
};

const textValues = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).flatMap((entry: unknown) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [],
  );

const inputQueries = (input: unknown): string[] =>
  typeof input === "object" && input !== null
    ? [
        ...new Set([
          ...textValues(Reflect.get(input, "queries")),
          ...textValues(Reflect.get(input, "query")),
        ]),
      ]
    : [];

/** A ledger item for a source a direct read returned, where it names one. */
const sourceRef = (source: ExternalSourceEntry): ChatStepRef | null => {
  const decision = source.caseLawDecision;
  if (decision !== undefined) {
    return {
      type: "decision",
      decisionId: decision.decisionId,
      caseNumber: decision.caseNumber,
      court: decision.citation?.court ?? source.caseLaw?.court ?? "",
      courtAbbreviation:
        decision.citation?.courtShortCode ??
        source.caseLaw?.courtShortCode ??
        null,
      country: "",
      decisionDate:
        decision.citation?.decisionDate ?? source.caseLaw?.decisionDate ?? null,
      ecli: null,
      summary: source.caseLaw?.holding ?? null,
      url: source.url,
      sourceUrl: source.sourceUrl ?? null,
    };
  }
  return null;
};

/**
 * The digest of one opened step: from its ledger when it is a code step that
 * recorded one, otherwise from a direct read's own input and typed result.
 * Null when the step names nothing a person would read: an old code step
 * from before ledgers were recorded, or a direct read whose result names
 * no source.
 */
export const stepDigestOf = ({
  citations,
  failed,
  part,
  refTargets,
}: {
  citations: ChatAnswerCitations;
  failed: boolean;
  part: StepToolPart;
  /** The step's message's ref bindings (`readChatStepRefTargets`). */
  refTargets: ChatStepRefTargets;
}): StepDigest | null => {
  const ledger = stepLedgerOf(part);
  if (ledger !== null) {
    const calls = ledger.calls.map((call, index): StepDigestCall => ({
      key: `${String(index)}:${call.tool}`,
      tool: call.tool,
      queries: call.queries,
      filters: call.filters,
      outcome: call.outcome,
      rows: digestRows(call.found, citations, refTargets),
      omitted: call.foundOmitted,
    }));
    return {
      calls,
      callsOmitted: ledger.callsOmitted,
      counts: countsOf(calls),
      recorded: true,
    };
  }
  if (isCodeToolName(part.name)) {
    return null;
  }
  const sources: ExternalSourceEntry[] = [];
  if (!failed) {
    collectExternalSources(part.output, sources);
  }
  const refs = sources.flatMap((source) => {
    const ref = sourceRef(source);
    return ref === null ? [] : [ref];
  });
  // A direct read's row already names its query; without a source to open,
  // its digest would only repeat that.
  if (refs.length === 0) {
    return null;
  }
  const queries = inputQueries(part.input);
  const calls: StepDigestCall[] = [
    {
      key: `0:${part.name}`,
      tool: part.name,
      queries,
      filters: [],
      outcome: failed ? "error" : "ok",
      rows: digestRows(refs, citations, refTargets),
      omitted: 0,
    },
  ];
  return {
    calls,
    callsOmitted: 0,
    counts: countsOf(calls),
    recorded: false,
  };
};
