import { tenantDecisionTableNames } from "@/api/lib/account-export/schema-census";
import type { DatabaseSchema } from "@/api/lib/account-export/schema-census";
import type { SafeId } from "@/api/lib/branded-types";

import type { IsDecisionReferenceKey } from "./withdrawn-copy-fields";
import type { WithdrawnCopyProjection } from "./withdrawn-copy-projection";

type Schema = DatabaseSchema;
type RowOf<T> = T extends { $inferSelect: infer Row } ? Row : never;
type SeenType<Seen extends readonly unknown[], Value> = Seen extends readonly [
  infer First,
  ...infer Rest,
]
  ? [Value] extends [First]
    ? [First] extends [Value]
      ? true
      : SeenType<Rest, Value>
    : SeenType<Rest, Value>
  : false;

type HasTaggedDecision<Value> = Value extends {
  targetType: infer Kind;
  targetId: unknown;
}
  ? string extends Kind
    ? false
    : "decision" extends Kind
      ? true
      : false
  : Value extends { type: infer Kind; id: unknown }
    ? string extends Kind
      ? false
      : "case_law_decision" extends Kind
        ? true
        : false
    : false;

type HasDecisionReference<
  Value,
  Seen extends readonly unknown[] = [],
> = unknown extends Value
  ? false
  : Value extends string
    ? Value extends SafeId<"caseLawDecision">
      ? true
      : false
    : HasTaggedDecision<Value> extends true
      ? true
      : Value extends Date
        ? false
        : SeenType<Seen, Value> extends true
          ? false
          : Value extends readonly (infer Item)[]
            ? HasDecisionReference<Item, [...Seen, Value]>
            : Value extends object
              ? true extends IsDecisionReferenceKey<keyof Value>
                ? true
                : {
                    [Key in keyof Value]: HasDecisionReference<
                      Value[Key],
                      [...Seen, Value]
                    >;
                  }[keyof Value]
              : false;

type DecisionKey<Row> = {
  [Field in keyof Row]: true extends HasDecisionReference<Row[Field]>
    ? Field
    : never;
}[keyof Row];

/** Includes typed JSON references as well as physical decision-id columns. */
export type DecisionCopyTableNames<Definitions> = {
  [Table in keyof Definitions]: RowOf<Definitions[Table]> extends infer Row
    ? "organizationId" extends keyof Row
      ? DecisionKey<Row> extends never
        ? never
        : Table
      : "workspaceId" extends keyof Row
        ? DecisionKey<Row> extends never
          ? never
          : Table
        : never
    : never;
}[keyof Definitions];

// Explicit payload owners already require exhaustive column classifications.
// Discover additional stores without re-walking their SDK and transcript types.
type TenantDecisionTable = DecisionCopyTableNames<
  Omit<Schema, DecisionPayloadTable>
>;

/** JSON and child stores whose decision association is carried by their parent or payload. */
type DecisionPayloadTable =
  | "legalReaderAnnotations"
  | "legalReaderAnswerMessages"
  | "chatThreadCompactions"
  | "chatMessages"
  | "chatMessageRevisions"
  | "chatRunLogs"
  | "chatRunLogEntries"
  | "chatMessageSearchDocuments"
  | "chatThreadSearchDocuments"
  | "chatThreadSearchPreviewPassages";

type CopyField = {
  kind: "identity" | "user-text" | "quote" | "generated" | "snapshot";
  projection: keyof Pick<
    WithdrawnCopyProjection,
    | "annotation"
    | "answer"
    | "answerMessage"
    | "chat"
    | "marker"
    | "compaction"
    | "thread"
  >;
};
type DecisionCopyRegistry = {
  [Table in TenantDecisionTable | DecisionPayloadTable]: {
    fields: { [Field in keyof RowOf<Schema[Table]>]?: CopyField };
    metadata: readonly (keyof RowOf<Schema[Table]>)[];
    decision: string;
  };
};

/** Each field names its persisted owner and the read projection that handles it. */
const WITHDRAWN_COPY_REGISTRY = {
  legalReaderAnnotations: {
    metadata: [
      "id",
      "organizationId",
      "userId",
      "targetType",
      "workspaceId",
      "verificationRunId",
      "verificationClaimId",
      "entityId",
      "pageTextSha256",
      "groupId",
      "kind",
      "visibility",
      "color",
      "style",
      "blockAnchorId",
      "startOffset",
      "endOffset",
      "createdAt",
      "updatedAt",
    ],
    decision: "targetType=decision:targetId",
    fields: {
      targetId: { kind: "identity", projection: "annotation" },
      quote: { kind: "quote", projection: "annotation" },
      body: { kind: "user-text", projection: "annotation" },
    },
  },
  legalReaderAnswers: {
    metadata: [
      "id",
      "organizationId",
      "userId",
      "kind",
      "visibility",
      "paragraphId",
      "startOffset",
      "endOffset",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ],
    decision: "decisionId",
    fields: {
      decisionId: { kind: "identity", projection: "answer" },
      quote: { kind: "quote", projection: "answer" },
      continuationSpans: { kind: "quote", projection: "answer" },
    },
  },
  legalReaderAnswerMessages: {
    metadata: [
      "id",
      "answerId",
      "sequence",
      "role",
      "model",
      "usage",
      "status",
      "errorCode",
      "invalidCitationCount",
      "createdAt",
      "updatedAt",
    ],
    decision: "answerId->legalReaderAnswers.decisionId;citations",
    fields: {
      content: { kind: "generated", projection: "answerMessage" },
      citations: { kind: "quote", projection: "answerMessage" },
    },
  },
  caseLawResearchAnswers: {
    metadata: [
      "columnId",
      "organizationId",
      "state",
      "claimId",
      "failureReason",
      "createdAt",
      "updatedAt",
    ],
    decision: "decisionId",
    fields: {
      decisionId: { kind: "identity", projection: "marker" },
      answer: { kind: "generated", projection: "marker" },
      run: { kind: "generated", projection: "marker" },
    },
  },
  caseLawMatterLinks: {
    metadata: ["id", "workspaceId", "linkedBy", "createdAt"],
    decision: "decisionId",
    fields: {
      decisionId: { kind: "identity", projection: "marker" },
      note: { kind: "user-text", projection: "marker" },
    },
  },
  chatThreads: {
    metadata: [
      "id",
      "workspaceId",
      "userId",
      "organizationId",
      "activeSkill",
      "titleSource",
      "rollbackToken",
      "contextMatterIds",
      "dataWorkspaceIds",
      "webSearchEnabled",
      "chatModel",
      "chatReasoningEffort",
      "recapMessageId",
      "recapPromptVersion",
      "recapGeneratedAt",
      "usedAnonymization",
      "parentThreadId",
      "forkedFromMessageId",
      "compactionScheduledAt",
      "compactionAttemptedAt",
      "compactionAttempts",
      "compactionEpoch",
      "createdAt",
      "updatedAt",
    ],
    decision: "subjectDecisionId",
    fields: {
      subjectDecisionId: { kind: "identity", projection: "thread" },
      recapText: { kind: "generated", projection: "thread" },
      title: { kind: "generated", projection: "thread" },
    },
  },
  chatThreadCompactions: {
    decision: "threadId->chatThreads.subjectDecisionId;summary;summaryMarkdown",
    fields: {
      summary: { kind: "generated", projection: "compaction" },
      summaryMarkdown: { kind: "generated", projection: "compaction" },
    },
    metadata: [
      "id",
      "threadId",
      "status",
      "firstSummarizedMessageId",
      "lastSummarizedMessageId",
      "firstKeptMessageId",
      "summarizedMessageCount",
      "deltaCursor",
      "totalSummarizedMessageCount",
      "totalTokens",
      "preservedTokens",
      "promptVersion",
      "modelProvider",
      "modelId",
      "memoryEligibility",
      "memoryExtractedAt",
      "memoryExtractionAttemptedAt",
      "memoryExtractionOrganizationId",
      "memoryExtractionConsentAt",
      "memoryExtractionDataWorkspaceIds",
      "createdAt",
    ],
  },
  chatMessages: {
    metadata: [
      "id",
      "threadId",
      "workspaceId",
      "userId",
      "role",
      "revision",
      "memoryExtractionEligible",
      "createdAt",
    ],
    decision: "content;threadId->chatThreads.subjectDecisionId",
    fields: { content: { kind: "snapshot", projection: "chat" } },
  },
  chatMessageRevisions: {
    metadata: [
      "id",
      "messageId",
      "threadId",
      "workspaceId",
      "revision",
      "createdBy",
      "createdAt",
    ],
    decision: "content;threadId->chatThreads.subjectDecisionId",
    fields: {
      content: { kind: "snapshot", projection: "chat" },
      edit: { kind: "user-text", projection: "chat" },
    },
  },
  chatRunLogs: {
    metadata: [
      "organizationId",
      "runId",
      "turnId",
      "nextSeq",
      "bytesUsed",
      "createdAt",
      "closedAt",
    ],
    decision: "referenceSummary.decisionIds",
    fields: { referenceSummary: { kind: "snapshot", projection: "marker" } },
  },
  chatRunLogEntries: {
    metadata: [
      "organizationId",
      "runId",
      "seq",
      "batchId",
      "batchIndex",
      "textMessageEndSeq",
    ],
    decision: "chunk;runId->chatTurns.threadId->chatThreads.subjectDecisionId",
    fields: { chunk: { kind: "snapshot", projection: "marker" } },
  },
  chatMessageSearchDocuments: {
    metadata: [
      "messageId",
      "threadId",
      "role",
      "tsv",
      "createdAt",
      "updatedAt",
    ],
    decision:
      "messageId->chatMessages.content;threadId->chatThreads.subjectDecisionId",
    fields: { searchableText: { kind: "generated", projection: "marker" } },
  },
  chatThreadSearchDocuments: {
    metadata: ["threadId", "previewGeneration", "tsv", "updatedAt"],
    decision: "threadId->chatThreads.subjectDecisionId;chatMessages.content",
    fields: {
      title: { kind: "generated", projection: "marker" },
      searchableText: { kind: "generated", projection: "marker" },
    },
  },
  chatThreadSearchPreviewPassages: {
    metadata: ["threadId", "generation", "ordinal", "tsv"],
    decision: "threadId->chatThreads.subjectDecisionId;chatMessages.content",
    fields: { content: { kind: "generated", projection: "marker" } },
  },
} as const satisfies DecisionCopyRegistry;

type Registry = typeof WITHDRAWN_COPY_REGISTRY;
export type DecisionCopyStore = keyof Registry;
type UnclassifiedCopyColumn = {
  [Table in keyof Registry]: Exclude<
    keyof RowOf<Schema[Table]>,
    keyof Registry[Table]["fields"] | Registry[Table]["metadata"][number]
  >;
}[keyof Registry];
type ConflictingCopyColumn = {
  [Table in keyof Registry]: Extract<
    keyof Registry[Table]["fields"],
    Registry[Table]["metadata"][number]
  >;
}[keyof Registry];
true satisfies UnclassifiedCopyColumn extends never ? true : never;
true satisfies ConflictingCopyColumn extends never ? true : never;

/** Require a projection for every schema-derived decision-associated store. */
export const unregisteredDecisionCopyStores = (
  tables?: Record<string, unknown>,
): string[] =>
  tenantDecisionTableNames(tables).filter(
    (name) => !Object.hasOwn(WITHDRAWN_COPY_REGISTRY, name),
  );
