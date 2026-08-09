import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { resolveWorkflowTargetEntityIds } from "@/api/lib/workflow-targets";

const entityId = (value: string) => toSafeId<"entity">(value);

const documentA = entityId("entity_document_a");
const documentB = entityId("entity_document_b");
const folder = entityId("entity_folder");
const link = entityId("entity_link");
const message = entityId("entity_message");
const task = entityId("entity_task");

const entityRows = [
  { id: documentA, kind: "document" },
  { id: folder, kind: "folder" },
  { id: task, kind: "task" },
  { id: message, kind: "message" },
  { id: link, kind: "link" },
  { id: documentB, kind: "document" },
] as const;

describe("workflow entity targeting", () => {
  test("only targets document entities for full workspace runs", () => {
    expect(resolveWorkflowTargetEntityIds({ entityRows })).toEqual([
      documentA,
      documentB,
    ]);
  });

  test("keeps explicit non-folder entity IDs while preserving requested priority", () => {
    expect(
      resolveWorkflowTargetEntityIds({
        entityRows,
        inputEntityIds: [folder, task, documentB, link, documentA],
        inputOrder: [documentA, task],
      }),
    ).toEqual([documentA, task, documentB, link]);
  });

  test("deduplicates explicit targets before workflow jobs are counted", () => {
    expect(
      resolveWorkflowTargetEntityIds({
        entityRows,
        inputEntityIds: [
          documentA,
          task,
          documentA,
          folder,
          documentB,
          task,
          link,
        ],
        inputOrder: [task, task, documentB],
      }),
    ).toEqual([task, documentB, documentA, link]);
  });
});
