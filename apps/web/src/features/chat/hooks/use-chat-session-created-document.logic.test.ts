import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import {
  clearPendingCreatedDocumentPersistence,
  invalidateCreatedDocumentQueries,
  pendingCreatedDocumentPersistenceKey,
  readPendingCreatedDocumentPersistence,
  writePendingCreatedDocumentPersistence,
} from "./use-chat-session-created-document.logic";

const createStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => {
      values.clear();
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()].at(index) ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
};

describe("invalidateCreatedDocumentQueries", () => {
  test("invalidates entity and activity caches only for the target matter", async () => {
    const queryClient = new QueryClient();
    const targetEntityRootKey = ["entities", "matter-a"];
    const targetEntityKey = [...targetEntityRootKey, "list"];
    const otherEntityKey = ["entities", "matter-b", "list"];
    const targetActivityRootKey = ["workspaces", "matter-a", "activity"];
    const targetActivityKey = [...targetActivityRootKey, "organization-a"];
    const otherActivityKey = [
      "workspaces",
      "matter-b",
      "activity",
      "organization-a",
    ];
    for (const key of [
      targetEntityKey,
      otherEntityKey,
      targetActivityKey,
      otherActivityKey,
    ]) {
      queryClient.setQueryData(key, { pages: [] });
    }

    await invalidateCreatedDocumentQueries({
      queryClient,
      queryKeys: [targetEntityRootKey, targetActivityRootKey],
    });

    expect(queryClient.getQueryState(targetEntityKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(targetActivityKey)?.isInvalidated).toBe(
      true,
    );
    expect(queryClient.getQueryState(otherEntityKey)?.isInvalidated).toBe(
      false,
    );
    expect(queryClient.getQueryState(otherActivityKey)?.isInvalidated).toBe(
      false,
    );
  });
});

describe("pending created-document persistence", () => {
  test("survives a reload boundary until persistence completes", () => {
    const storage = createStorage();
    const key = pendingCreatedDocumentPersistenceKey("thread-1", "tool-1");
    const pending = {
      draftMessageId: "message-1",
      matterId: "matter-1",
      output: {
        entityId: "entity-1",
        entityRef: "entity-1",
        fieldId: "field-1",
        fileName: "draft.docx",
        href: "#stella-entity=matter-1:entity-1",
        matterRef: "matter-1",
        mention: "[draft.docx](#stella-entity=matter-1:entity-1)",
        success: true,
        workspaceId: "matter-1",
      },
      toolCallId: "tool-1",
    } as const;

    writePendingCreatedDocumentPersistence(storage, key, pending);
    expect(readPendingCreatedDocumentPersistence(storage, key)).toEqual(
      pending,
    );
    clearPendingCreatedDocumentPersistence(storage, key);
    expect(readPendingCreatedDocumentPersistence(storage, key)).toBeNull();
  });
});
