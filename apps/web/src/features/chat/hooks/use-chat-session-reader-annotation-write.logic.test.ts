import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import type { ReaderAnnotationWriteMessage } from "@/components/chat/chat-ui-tools";
import { readerAnnotationKeys } from "@/components/legal-reader/annotations/reader-annotations-query";
import { reconcileReaderAnnotationWriteToolCalls } from "@/features/chat/hooks/use-chat-session-reader-annotation-write.logic";

const ANNOTATIONS_KEY = readerAnnotationKeys.forTarget({
  activeOrganizationId: "org-1",
  targetId: "decision-1",
  targetType: "decision",
});
const UNRELATED_KEY = ["legal-reader", "document"];

const writeMessages = ({
  name,
  output,
  state = "complete",
}: {
  name: string;
  output: Record<string, unknown>;
  state?: string;
}): ReaderAnnotationWriteMessage[] => [
  {
    id: "message-1",
    parts: [
      {
        id: "tool-call-1",
        input: {},
        name,
        output,
        state,
        type: "tool-call",
      },
    ],
    role: "assistant",
  },
];

const CREATE_WRITE = writeMessages({
  name: "create_reader_annotation",
  output: { annotationId: "annotation-1", passages: [] },
});
const SUCCESSFUL_WRITES = [
  CREATE_WRITE,
  writeMessages({
    name: "update_reader_annotation",
    output: { annotationId: "annotation-1", updated: true },
  }),
  writeMessages({
    name: "delete_reader_annotation",
    output: { deleted: true },
  }),
];

const seededQueryClient = () => {
  const queryClient = new QueryClient();
  for (const queryKey of [ANNOTATIONS_KEY, UNRELATED_KEY]) {
    queryClient.setQueryData(queryKey, { seeded: true });
  }
  return queryClient;
};

const isInvalidated = (
  queryClient: QueryClient,
  queryKey: readonly unknown[],
) => queryClient.getQueryState(queryKey)?.isInvalidated ?? false;

describe("reader annotation write cache reconciliation", () => {
  test("each completed write invalidates the reader's annotations only", async () => {
    for (const messages of SUCCESSFUL_WRITES) {
      const queryClient = seededQueryClient();

      await reconcileReaderAnnotationWriteToolCalls({
        handledToolCallIds: new Set(),
        messages,
        queryClient,
      });

      expect(isInvalidated(queryClient, ANNOTATIONS_KEY)).toBe(true);
      expect(isInvalidated(queryClient, UNRELATED_KEY)).toBe(false);
    }
  });

  test("a refused, unfinished, or unrelated call invalidates nothing", async () => {
    for (const messages of [
      writeMessages({
        name: "create_reader_annotation",
        output: { error: { code: "not_found" } },
      }),
      writeMessages({
        name: "delete_reader_annotation",
        output: { deleted: true },
        state: "input-streaming",
      }),
      writeMessages({
        name: "delete_clause",
        output: { deleted: true },
      }),
    ]) {
      const queryClient = seededQueryClient();

      await reconcileReaderAnnotationWriteToolCalls({
        handledToolCallIds: new Set(),
        messages,
        queryClient,
      });

      expect(isInvalidated(queryClient, ANNOTATIONS_KEY)).toBe(false);
    }
  });

  test("a write is handled once, however often the transcript re-renders", async () => {
    const handledToolCallIds = new Set<string>();
    await reconcileReaderAnnotationWriteToolCalls({
      handledToolCallIds,
      messages: CREATE_WRITE,
      queryClient: seededQueryClient(),
    });
    const queryClient = seededQueryClient();

    await reconcileReaderAnnotationWriteToolCalls({
      handledToolCallIds,
      messages: CREATE_WRITE,
      queryClient,
    });

    expect(isInvalidated(queryClient, ANNOTATIONS_KEY)).toBe(false);
  });
});
