import {
  chatDecisionPassagesIn,
  findCanonicalChatResourceHrefs,
} from "@stll/api-contract";
import { isUuid } from "@stll/uuid-codec";

import type {
  chatMessages,
  chatThreadCompactions,
  chatThreads,
  legalReaderAnnotations,
  legalReaderAnswerMessages,
  legalReaderAnswers,
} from "@/api/db/schema";
import { proveTextOnlyPersistedChatMessageContent } from "@/api/lib/chat/persisted-message-content";

import { isDecisionReferenceKey } from "./withdrawn-copy-fields";

type DecisionReferences = Set<string>;

/** Explicit identities survive nested tool snapshots and citation links. */
export const decisionReferencesIn = (value: unknown): DecisionReferences => {
  const references: DecisionReferences = new Set();
  const visit = (item: unknown, key: string): void => {
    if (typeof item === "string") {
      if (isDecisionReferenceKey(key) && isUuid(item)) {
        references.add(item.toLowerCase());
      }
      for (const { decisionId } of chatDecisionPassagesIn(item)) {
        if (isUuid(decisionId)) {
          references.add(decisionId.toLowerCase());
        }
      }
      for (const { target } of findCanonicalChatResourceHrefs(item)) {
        if (target.type === "case_law_decision" && isUuid(target.resource.id)) {
          references.add(target.resource.id.toLowerCase());
        }
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child, key);
      }
      return;
    }
    if (typeof item === "object" && item !== null) {
      let taggedId: unknown;
      if (
        "targetType" in item &&
        item.targetType === "decision" &&
        "targetId" in item
      ) {
        taggedId = item.targetId;
      } else if (
        "type" in item &&
        item.type === "case_law_decision" &&
        "id" in item
      ) {
        taggedId = item.id;
      }
      if (typeof taggedId === "string" && isUuid(taggedId)) {
        references.add(taggedId.toLowerCase());
      }
      for (const [childKey, child] of Object.entries(item)) {
        visit(child, childKey);
      }
    }
  };
  visit(value, "");
  return references;
};

/** A batch's verdict is shared by all projections assembled from that batch. */
export class WithdrawnCopyProjection {
  private readonly withdrawnIds: ReadonlySet<string>;
  private readonly label: string;

  constructor(decisionIds: readonly string[], label: string) {
    this.withdrawnIds = new Set(decisionIds.map((id) => id.toLowerCase()));
    this.label = label;
  }

  marker(value: unknown, decisionId?: string | null): string | null {
    if (
      decisionId !== undefined &&
      decisionId !== null &&
      this.withdrawnIds.has(decisionId.toLowerCase())
    ) {
      return this.label;
    }
    return [...decisionReferencesIn(value)].some((id) =>
      this.withdrawnIds.has(id),
    )
      ? this.label
      : null;
  }

  annotation<
    T extends Pick<
      typeof legalReaderAnnotations.$inferSelect,
      "quote" | "body"
    >,
  >(row: T, decisionId: string | null): T {
    const marker = this.marker(null, decisionId);
    return marker === null ? row : { ...row, quote: marker };
  }

  answer<
    T extends Pick<
      typeof legalReaderAnswers.$inferSelect,
      "decisionId" | "quote" | "continuationSpans"
    >,
  >(row: T): T {
    const marker = this.marker(null, row.decisionId);
    return marker === null
      ? row
      : {
          ...row,
          quote: marker,
          continuationSpans: row.continuationSpans.map((span) => ({
            ...span,
            quote: marker,
          })),
        };
  }

  answerMessage<
    T extends Pick<
      typeof legalReaderAnswerMessages.$inferSelect,
      "role" | "content" | "citations"
    >,
  >(row: T, decisionId: string): T {
    if (row.role === "user") {
      return row;
    }
    const marker = this.marker(row, decisionId);
    return marker === null ? row : { ...row, content: marker, citations: [] };
  }

  thread<
    T extends Pick<
      typeof chatThreads.$inferSelect,
      "title" | "titleSource" | "subjectDecisionId"
    > & { recapText?: string | null },
  >(row: T): T {
    const marker = this.marker(row, row.subjectDecisionId);
    if (marker === null) {
      return row;
    }
    return {
      ...row,
      title: row.titleSource === "user" ? row.title : marker,
      ...(row.recapText === undefined ? {} : { recapText: marker }),
    };
  }

  compaction<
    T extends Pick<
      typeof chatThreadCompactions.$inferSelect,
      "summary" | "summaryMarkdown"
    >,
  >(row: T, decisionId?: string | null): T {
    const marker = this.marker(row, decisionId);
    if (marker === null) {
      return row;
    }
    return {
      ...row,
      summaryMarkdown: marker,
      summary: {
        version: 1,
        goal: marker,
        blocked: [],
        constraints: [],
        criticalContext: [],
        done: [],
        inProgress: [],
        keyDecisions: [],
        modifiedFiles: [],
        nextSteps: [],
        readFiles: [],
      },
    };
  }

  chat<
    T extends {
      role: string;
      content: (typeof chatMessages.$inferSelect)["content"];
    },
  >(row: T, decisionId?: string | null): T {
    if (row.role === "user") {
      return row;
    }
    const marker = this.marker(row.content, decisionId);
    return marker === null
      ? row
      : {
          ...row,
          content: proveTextOnlyPersistedChatMessageContent({
            version: 3,
            data: [{ type: "text", content: marker }],
          }),
        };
  }
}
