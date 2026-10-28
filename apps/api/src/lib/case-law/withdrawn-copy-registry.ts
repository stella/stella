import { getColumns, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as schema from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import { isDecisionReferenceKey } from "./withdrawn-copy-fields";
import type { IsDecisionReferenceKey } from "./withdrawn-copy-fields";
import type { WithdrawnCopyProjection } from "./withdrawn-copy-projection";

type Schema = typeof schema;
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

type HasDecisionReference<
  Value,
  Seen extends readonly unknown[] = [],
> = unknown extends Value
  ? false
  : Value extends string
    ? Value extends SafeId<"caseLawDecision">
      ? true
      : false
    : Value extends Date
      ? false
      : SeenType<Seen, Value> extends true
        ? false
        : Value extends readonly (infer Item)[]
          ? HasDecisionReference<Item, [...Seen, Value]>
          : Value extends object
            ? {
                [Key in keyof Value]: IsDecisionReferenceKey<Key> extends true
                  ? true
                  : HasDecisionReference<Value[Key], [...Seen, Value]>;
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

type TenantDecisionTable = DecisionCopyTableNames<Schema>;

/** JSON and child stores whose decision association is carried by their parent or payload. */
type DecisionPayloadTable =
  | "legalReaderAnnotations"
  | "legalReaderAnswerMessages"
  | "chatMessages"
  | "chatMessageRevisions"
  | "chatRunLogEntries"
  | "chatMessageSearchDocuments"
  | "chatThreadSearchDocuments"
  | "chatThreadSearchPreviewPassages";

type CopyField = {
  kind: "identity" | "user-text" | "quote" | "generated" | "snapshot";
  projection: keyof Pick<
    WithdrawnCopyProjection,
    "annotation" | "answer" | "answerMessage" | "chat" | "marker"
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
      subjectDecisionId: { kind: "identity", projection: "marker" },
      recapText: { kind: "generated", projection: "marker" },
      title: { kind: "generated", projection: "marker" },
    },
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
  chatRunLogEntries: {
    metadata: ["organizationId", "runId", "seq", "batchId", "batchIndex"],
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

/** Enumerate the real schema, including decision keys without foreign keys. */
export const unregisteredDecisionCopyStores = (
  tables: Record<string, unknown> = schema,
): string[] => {
  const missing: string[] = [];
  for (const [name, value] of Object.entries(tables)) {
    if (!is(value, PgTable)) {
      continue;
    }
    const columns = getColumns(value);
    if (!("organizationId" in columns) && !("workspaceId" in columns)) {
      continue;
    }
    const hasDecisionKey = Object.values(columns).some((column) =>
      isDecisionReferenceKey(column.name),
    );
    const hasDecisionTarget =
      columns["targetType"]?.enumValues?.includes("decision") === true &&
      "targetId" in columns;
    const hasDecisionForeignKey = getTableConfig(value).foreignKeys.some(
      (foreignKey) =>
        getTableConfig(foreignKey.reference().foreignTable).name ===
        getTableConfig(schema.caseLawDecisions).name,
    );
    if (
      (hasDecisionKey || hasDecisionTarget || hasDecisionForeignKey) &&
      !Object.hasOwn(WITHDRAWN_COPY_REGISTRY, name)
    ) {
      missing.push(name);
    }
  }
  return missing;
};
