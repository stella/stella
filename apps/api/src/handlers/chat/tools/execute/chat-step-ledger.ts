import { panic } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";
import * as v from "valibot";

import {
  CHAT_STEP_LEDGER_LIMITS,
  type ChatStepCall,
  type ChatStepCallOutcome,
  type ChatStepFilter,
  type ChatStepFilterKind,
  type ChatStepLedger,
  type ChatStepRef,
} from "@stll/api-contract/chat-step-ledger";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import type { RegistryReadToolName } from "@/api/handlers/chat/tools/registry-adapter/ref-field-map";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  brandPersistedEntityId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/**
 * The server half of the step ledger (`@stll/api-contract/chat-step-ledger`):
 * which reads a code step made and what each one found, taken from the reads
 * themselves rather than from what the script returned.
 *
 * Every found item comes from the read's own answer after egress, the
 * answer an MCP client of the same member would receive, so nothing a source
 * withholds and nothing the member may not read can appear: a read the
 * member may not make is refused before it answers, and a matter item from
 * outside the turn's authorized matters is dropped here as well.
 *
 * A matter document or a matter is named by its title and by the chat ref
 * the turn's ref registry spells it with (`ent_3`, `mat_1`), the ref the
 * model reads it by, never by an id: the ledger rides on a tool result. The
 * stored message binds each ref it holds (`refContext`), which is how a page
 * opens the item later.
 */

/** What one registry read answered: its normalized arguments and payload. */
type ChatStepReadAnswer = {
  args: Record<string, unknown>;
  data: unknown;
};

/** Where one read of a script leaves its answer for the ledger. */
export type ChatStepCallSink = {
  answered: (answer: ChatStepReadAnswer) => void;
};

/** A sink that keeps nothing, for reads outside a recorded step. */
const DISCARDING_STEP_CALL_SINK: ChatStepCallSink = {
  answered: () => undefined,
};

/**
 * The turn's chat refs for a matter document and a matter, minted (or
 * reused) by the turn's one ref registry, so a step names an item by the
 * spelling the model reads it by.
 */
type ChatStepRefMinter = {
  document: (target: { entityId: string; matterId: string }) => string;
  matter: (matterId: string) => string;
};

export type ChatStepRefScope = {
  /** The matters the turn may read; a matter item outside them is dropped. */
  workspaceIds: ReadonlySet<string>;
  refs: ChatStepRefMinter;
};

/**
 * A step's scope in a turn: the matters it may name, by the refs of the
 * turn's own registry. That is the registry the read's projection mints into
 * what the script receives, so the step and the model spell an item alike,
 * and the stored message binds the ref (`collectRefBindings`).
 */
export const chatStepRefScope = ({
  refRegistry,
  workspaceIds,
}: {
  refRegistry: ChatRefRegistry;
  workspaceIds: Iterable<string>;
}): ChatStepRefScope => ({
  workspaceIds: new Set(workspaceIds),
  refs: {
    document: ({ entityId, matterId }) =>
      refRegistry.toEntityRef({
        entityId: brandPersistedEntityId(entityId),
        workspaceId: brandPersistedWorkspaceId(matterId),
      }),
    matter: (matterId) =>
      refRegistry.toMatterRef(brandPersistedWorkspaceId(matterId)),
  },
});

/**
 * One item a read found and the key it is told apart by. A public item is
 * kept as found; a matter item carries the matter it belongs to, which
 * decides whether the turn may name it, and gets its chat ref only once it
 * is kept. Neither id is ever kept.
 */
type FoundItem = { key: string } & (
  | { type: "public"; ref: ChatStepRef }
  | {
      type: "document";
      entityId: string;
      matterId: string;
      title: string;
      kind: string | null;
    }
  | { type: "matter"; matterId: string; title: string }
);

type StepRefReader = (answer: ChatStepReadAnswer) => FoundItem[];

const clip = (value: string): string =>
  value.length <= CHAT_STEP_LEDGER_LIMITS.textLength
    ? value
    : `${value.slice(0, CHAT_STEP_LEDGER_LIMITS.textLength - 1)}…`;

const text = v.pipe(v.string(), v.trim(), v.nonEmpty(), v.transform(clip));
const optionalText = v.fallback(v.optional(v.nullable(text), null), null);

/** Lenient readers: a field a payload lacks reads as null, an entry with no
 *  identity is skipped. They strip every field they do not name. */
const decisionFields = v.object({
  decisionId: text,
  caseNumber: text,
  court: text,
  courtAbbreviation: optionalText,
  country: text,
  decisionDate: optionalText,
  ecli: optionalText,
  url: optionalText,
  source_url: optionalText,
  headnote: v.fallback(
    v.optional(v.nullable(v.object({ text: optionalText })), null),
    null,
  ),
  metadata: v.fallback(
    v.optional(v.nullable(v.object({ popularName: optionalText })), null),
    null,
  ),
});

const toDecisionRef = (
  value: v.InferOutput<typeof decisionFields>,
): FoundItem => ({
  key: `decision:${value.decisionId}`,
  type: "public",
  ref: {
    type: "decision",
    decisionId: value.decisionId,
    caseNumber: value.caseNumber,
    court: value.court,
    courtAbbreviation: value.courtAbbreviation,
    country: value.country,
    // A search hit dates its decision as an instant at midnight UTC.
    decisionDate: value.decisionDate?.slice(0, 10) ?? null,
    ecli: value.ecli,
    summary: value.metadata?.popularName ?? value.headnote?.text ?? null,
    url: value.url,
    sourceUrl: value.source_url,
  },
});

const statuteFields = v.object({
  eli: text,
  anchor: optionalText,
  citation: optionalText,
  title: optionalText,
  versionValidFrom: optionalText,
  versionValidTo: optionalText,
  url: optionalText,
  source_url: optionalText,
});

const toStatuteRef = (
  value: v.InferOutput<typeof statuteFields>,
): FoundItem => ({
  key: `statute:${value.eli}#${value.anchor ?? ""}@${value.versionValidFrom ?? ""}`,
  type: "public",
  ref: {
    type: "statute",
    eli: value.eli,
    anchor: value.anchor,
    label: value.citation ?? value.title ?? value.anchor ?? value.eli,
    validFrom: value.versionValidFrom,
    validTo: value.versionValidTo,
    url: value.url,
    sourceUrl: value.source_url,
  },
});

/** Each entry of `list` that `schema` reads, mapped; the rest skipped. */
const readEach = <TSchema extends v.GenericSchema>(
  list: unknown,
  schema: TSchema,
  map: (value: v.InferOutput<TSchema>) => FoundItem | null,
): FoundItem[] =>
  Array.isArray(list)
    ? list.flatMap((entry: unknown) => {
        const parsed = v.safeParse(schema, entry);
        const ref = parsed.success ? map(parsed.output) : null;
        return ref === null ? [] : [ref];
      })
    : [];

const field = (value: unknown, key: string): unknown =>
  isRecord(value) ? value[key] : undefined;

const stringArg = (
  args: Record<string, unknown>,
  key: string,
): string | null => {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
};

const documentFields = v.object({
  entityId: text,
  workspaceId: text,
  name: text,
  kind: optionalText,
});

const toDocumentRef = (
  value: v.InferOutput<typeof documentFields>,
): FoundItem => ({
  key: `document:${value.workspaceId}:${value.entityId}`,
  type: "document",
  entityId: value.entityId,
  matterId: value.workspaceId,
  title: value.name,
  kind: value.kind,
});

const readFoundDecisions: StepRefReader = ({ data }) =>
  readEach(
    field(data, "items"),
    v.object({ decision: decisionFields }),
    (item) => toDecisionRef(item.decision),
  );

const readMatterDocuments: StepRefReader = ({ args, data }) => {
  const matterId = stringArg(args, "matter_id");
  return matterId === null
    ? []
    : readEach(
        field(data, "documents"),
        v.object({ id: text, name: text, kind: optionalText }),
        (document) =>
          toDocumentRef({
            entityId: document.id,
            workspaceId: matterId,
            name: document.name,
            kind: document.kind,
          }),
      );
};

const readOneDocument: StepRefReader = ({ args, data }) => {
  const matterId = stringArg(args, "matter_id");
  const parsed = v.safeParse(
    v.object({ entityId: text, name: text, kind: optionalText }),
    data,
  );
  return matterId === null || !parsed.success
    ? []
    : [
        toDocumentRef({
          entityId: parsed.output.entityId,
          workspaceId: matterId,
          name: parsed.output.name,
          kind: parsed.output.kind,
        }),
      ];
};

/**
 * What each read's answer names, by tool. Exhaustive over the read catalog,
 * so a new read cannot ship without deciding what its step row shows; `null`
 * records the call (what was asked, whether it went through) with nothing
 * found, for reads whose answer is not a citable item.
 */
const STEP_REF_READERS = {
  search_case_law: ({ data }) =>
    readEach(field(data, "results"), decisionFields, toDecisionRef),
  read_case_law_decision: readFoundDecisions,
  search_legislation: ({ data }) =>
    readEach(field(data, "results"), statuteFields, (hit) =>
      toStatuteRef({ ...hit, anchor: null, citation: null }),
    ),
  read_statute: ({ data }) =>
    readEach([field(data, "statute")], statuteFields, (statute) =>
      toStatuteRef({ ...statute, anchor: null, citation: null }),
    ),
  read_statute_provisions: ({ data }) =>
    readEach(
      field(data, "items"),
      v.object({ ...statuteFields.entries, status: v.literal("found") }),
      toStatuteRef,
    ),
  search_across_matters: ({ data }) =>
    readEach(field(data, "hits"), documentFields, toDocumentRef),
  read_content_across_matters: ({ data }) =>
    readEach([data], documentFields, toDocumentRef),
  list_documents: readMatterDocuments,
  read_document: readOneDocument,
  list_matters: ({ data }) =>
    readEach(
      field(data, "matters"),
      v.object({ id: text, name: text }),
      (matter): FoundItem => ({
        key: `matter:${matter.id}`,
        type: "matter",
        matterId: matter.id,
        title: matter.name,
      }),
    ),
  fetch: null,
  search: null,
  list_contacts: null,
  resolve_case_law_decision: null,
  resolve_law_citation: null,
  case_law_coverage: null,
  read_case_law_citations: null,
  verify_quote: null,
  read_contact: null,
  list_templates: null,
  preview_template_conditions: null,
  list_properties: null,
  list_tasks: null,
  lookup_business_registry: null,
  check_counterparty: null,
  list_clauses: null,
  list_playbooks: null,
  list_reader_annotations: null,
  list_time_entries: null,
  resolve_rate: null,
  list_invoices: null,
  get_usage: null,
  search_guidance: null,
  read_guidance: null,
  read_provision_history: null,
  search_boe_legislation: null,
  list_audit_log: null,
  prepare_feedback: null,
  list_capabilities: null,
  describe_capability: null,
  [MCP_CAPABILITY_EXECUTORS.read]: null,
  open_case_law_decision: null,
  read_case_law_decision_blocks: null,
  preview_cited_provision: null,
  list_case_law_courts: null,
} as const satisfies Record<RegistryReadToolName, StepRefReader | null>;

/** The arguments a person recognises as a filter, by argument name. */
const FILTER_ARGS = [
  ["country", "country"],
  ["court", "court"],
  ["courts", "court"],
  ["decision_type", "decisionType"],
  ["document_type", "documentType"],
  ["status", "status"],
  ["language", "language"],
  ["date_from", "dateFrom"],
  ["date_to", "dateTo"],
  ["as_of", "asOf"],
] as const satisfies readonly (readonly [string, ChatStepFilterKind])[];

const textValues = (value: unknown): string[] => {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry: unknown) =>
    typeof entry === "string" && entry.trim().length > 0
      ? [clip(entry.trim())]
      : [],
  );
};

/** What a read searched for, in the words it was given. */
const readQueries = (args: Record<string, unknown>): string[] =>
  [
    ...new Set([...textValues(args["queries"]), ...textValues(args["query"])]),
  ].slice(0, CHAT_STEP_LEDGER_LIMITS.queriesPerCall);

const readFilters = (args: Record<string, unknown>): ChatStepFilter[] =>
  FILTER_ARGS.flatMap(([arg, kind]) =>
    textValues(args[arg]).map((value) => ({ kind, value })),
  ).slice(0, CHAT_STEP_LEDGER_LIMITS.filtersPerCall);

/** Whether the turn may name `item`: a matter item only from its matters. */
const isInScope = (item: FoundItem, scope: ChatStepRefScope | undefined) =>
  item.type === "public" || scope?.workspaceIds.has(item.matterId) === true;

const scopeRefs = (scope: ChatStepRefScope | undefined): ChatStepRefMinter =>
  scope?.refs ?? panic("A matter item was kept outside the turn's matters");

/** What the ledger keeps of an in-scope item: a matter item by its ref. */
const keptRef = (
  item: FoundItem,
  scope: ChatStepRefScope | undefined,
): ChatStepRef => {
  switch (item.type) {
    case "public":
      return item.ref;
    case "document":
      return {
        type: "document",
        ref: scopeRefs(scope).document({
          entityId: item.entityId,
          matterId: item.matterId,
        }),
        title: item.title,
        kind: item.kind,
      };
    case "matter":
      return {
        type: "matter",
        ref: scopeRefs(scope).matter(item.matterId),
        title: item.title,
      };
    default:
      item satisfies never;
      return panic("Unhandled step ledger item");
  }
};

const STEP_REF_READER_BY_TOOL: ReadonlyMap<string, StepRefReader | null> =
  new Map(Object.entries(STEP_REF_READERS));

const readerOf = (tool: string): StepRefReader | null =>
  STEP_REF_READER_BY_TOOL.get(tool) ?? null;

type RecordStepCallProps = {
  tool: string;
  /** The arguments the script passed, for a read that never answered. */
  callArgs: unknown;
  answer: ChatStepReadAnswer | undefined;
  outcome: ChatStepCallOutcome;
};

/** One step's ledger, filled as its reads settle. */
export type ChatStepLedgerRecorder = {
  record: (props: RecordStepCallProps) => void;
  ledger: () => ChatStepLedger;
};

export const createChatStepLedgerRecorder = (
  scope?: ChatStepRefScope,
): ChatStepLedgerRecorder => {
  const calls: ChatStepCall[] = [];
  let callsOmitted = 0;
  return {
    record: ({ tool, callArgs, answer, outcome }) => {
      if (calls.length >= CHAT_STEP_LEDGER_LIMITS.calls) {
        callsOmitted += 1;
        return;
      }
      const args = answer?.args ?? (isRecord(callArgs) ? callArgs : {});
      const reader = readerOf(tool);
      const seen = new Set<string>();
      const named =
        answer === undefined || reader === null
          ? []
          : reader(answer).filter((item) => {
              if (!isInScope(item, scope) || seen.has(item.key)) {
                return false;
              }
              seen.add(item.key);
              return true;
            });
      calls.push({
        tool: clip(tool),
        queries: readQueries(args),
        filters: readFilters(args),
        outcome,
        // Only a kept item is given a ref; one past the limit is counted.
        found: named
          .slice(0, CHAT_STEP_LEDGER_LIMITS.refsPerCall)
          .map((item) => keptRef(item, scope)),
        foundOmitted: Math.max(
          0,
          named.length - CHAT_STEP_LEDGER_LIMITS.refsPerCall,
        ),
      });
    },
    ledger: () => ({ calls: [...calls], callsOmitted }),
  };
};

/** The read in flight on this async path, inside a recorded step. */
const currentStepCall = new AsyncLocalStorage<ChatStepCallSink>();

/**
 * Run one read of a recorded step, settling its ledger entry by how it
 * ended. `run` resolves to what the script receives; whatever it returns or
 * throws passes through unchanged.
 */
export const runRecordedStepCall = async <T>({
  recorder,
  tool,
  callArgs,
  run,
}: {
  recorder: ChatStepLedgerRecorder;
  tool: string;
  callArgs: unknown;
  run: () => Promise<T>;
}): Promise<T> => {
  let answer: ChatStepReadAnswer | undefined;
  const sink: ChatStepCallSink = {
    answered: (value) => {
      answer = value;
    },
  };
  // The read's own settlement decides its entry; whatever it resolves or
  // rejects with reaches the script untouched. A read that rejected never
  // got here, so its entry keeps no answer.
  const settled: { outcome: ChatStepCallOutcome } = { outcome: "error" };
  return await currentStepCall
    .run(sink, run)
    .then((value) => {
      settled.outcome = "ok";
      return value;
    })
    .finally(() => {
      recorder.record({
        tool,
        callArgs,
        answer: settled.outcome === "ok" ? answer : undefined,
        outcome: settled.outcome,
      });
    });
};

/** The sink of the read on this async path, or one that keeps nothing. */
export const stepCallSink = (): ChatStepCallSink =>
  currentStepCall.getStore() ?? DISCARDING_STEP_CALL_SINK;
