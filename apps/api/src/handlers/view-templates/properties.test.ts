import { describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db";
import { properties, propertyDependencies } from "@/api/db/schema";
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

const createTemplateDependencyTx = () => {
  const createdPropertyIds = ["created_a", "created_b"];
  const returningMock = mock(async () => [{ id: createdPropertyIds.shift() }]);
  const propertyValuesMock = mock(() => ({
    returning: returningMock,
  }));
  const dependencyValuesMock = mock(() => ({
    onConflictDoNothing: mock(async () => undefined),
  }));
  const insertMock = mock((table: unknown) => {
    if (table === properties) {
      return { values: propertyValuesMock };
    }
    if (table === propertyDependencies) {
      return { values: dependencyValuesMock };
    }
    throw new Error("Unexpected table insert");
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
    dependencyValuesMock,
    returningMock,
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

  test("rejects cyclic dependencies between newly created template columns", async () => {
    const { dependencyValuesMock, returningMock, tx } =
      createTemplateDependencyTx();
    const propertyA = {
      version: 1,
      sourceId: "source_a",
      name: "A",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "ai-model", prompt: "Extract A" },
      createIfMissing: true,
      dependencies: [{ dependsOnSourceId: "source_b", condition: null }],
    } satisfies ViewTemplateProperty;
    const propertyB = {
      version: 1,
      sourceId: "source_b",
      name: "B",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "ai-model", prompt: "Extract B" },
      createIfMissing: true,
      dependencies: [{ dependsOnSourceId: "source_a", condition: null }],
    } satisfies ViewTemplateProperty;

    const result = await resolveTemplateProperties({
      tx,
      workspaceId,
      layout: tableLayout(propertyA.sourceId),
      templateProperties: [propertyA, propertyB],
      canCreateProperties: true,
    });

    expect(result).toEqual({
      ok: false,
      status: 422,
      message: "Circular template dependency detected",
    });
    expect(returningMock).not.toHaveBeenCalled();
    expect(dependencyValuesMock).not.toHaveBeenCalled();
  });
});
