import { describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db";
import { resolveTemplateProperties } from "@/api/handlers/view-templates/properties";
import { toSafeId } from "@/api/lib/branded-types";
import type { ViewLayout, ViewTemplateProperty } from "@/api/lib/views-schema";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const workspaceId = toSafeId<"workspace">("workspace_1");

const tableLayout = (propertyId: string): ViewLayout => ({
  version: 1,
  type: "table",
  filters: [],
  sorts: [],
  hiddenProperties: [],
  columnOrder: [propertyId],
  columnPinning: [],
});

const createTemplatePropertyValidationTx = () => {
  const insertMock = mock(() => {
    throw new Error("Unexpected template property insert");
  });
  const tx = {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => ({
          for: mock(async () => []),
        })),
      })),
    })),
    query: {
      properties: {
        findMany: mock(async () => []),
      },
    },
    insert: insertMock,
  };

  return {
    insertMock,
    tx: asTestRaw<Transaction>(tx),
  };
};

describe("resolveTemplateProperties", () => {
  test("rejects file template columns with AI tools before inserting", async () => {
    const { insertMock, tx } = createTemplatePropertyValidationTx();
    const templateProperty = {
      version: 1,
      sourceId: "source_file",
      name: "File",
      content: { version: 1, type: "file" },
      tool: { version: 1, type: "ai-model", prompt: "Extract" },
      createIfMissing: true,
    } satisfies ViewTemplateProperty;

    const result = await resolveTemplateProperties({
      tx,
      workspaceId,
      layout: tableLayout(templateProperty.sourceId),
      templateProperties: [templateProperty],
      canCreateProperties: true,
    });

    expect(result).toEqual({
      ok: false,
      status: 422,
      message: "File template columns must use manual input",
    });
    expect(insertMock).not.toHaveBeenCalled();
  });

  test("rejects select template fallbacks that are not valid options", async () => {
    const { insertMock, tx } = createTemplatePropertyValidationTx();
    const templateProperty = {
      version: 1,
      sourceId: "source_select",
      name: "Status",
      content: {
        version: 1,
        type: "single-select",
        options: [{ color: "green", value: "Open" }],
        fallback: "Closed",
      },
      tool: { version: 1, type: "manual-input" },
      createIfMissing: true,
    } satisfies ViewTemplateProperty;

    const result = await resolveTemplateProperties({
      tx,
      workspaceId,
      layout: tableLayout(templateProperty.sourceId),
      templateProperties: [templateProperty],
      canCreateProperties: true,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: "Fallback must match one of the supplied options",
    });
    expect(insertMock).not.toHaveBeenCalled();
  });
});
