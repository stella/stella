import { describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db";
import { properties, propertyDependencies } from "@/api/db/schema";
import {
  collectTemplateProperties,
  resolveTemplateProperties,
} from "@/api/handlers/view-templates/properties";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { ViewLayout, ViewTemplateProperty } from "@/api/lib/views-schema";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const workspaceId = toSafeId<"workspace">("workspace_1");
const noopAuditRecorder: AuditRecorder = async () => {
  await Promise.resolve();
};

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
  const executeMock = mock(async () => undefined);
  const tx = {
    execute: executeMock,
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
    executeMock,
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
  const executeMock = mock(async () => undefined);
  const tx = {
    execute: executeMock,
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
    executeMock,
    returningMock,
    tx: asTestRaw<Transaction>(tx),
  };
};

const createTemplateReuseTx = () => {
  const existingProperty = {
    id: "existing_property",
    name: "Status",
    content: { version: 1, type: "text" },
    tool: { version: 1, type: "manual-input" },
  };
  const returningMock = mock(async () => [{ id: "created_property" }]);
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
    execute: mock(async () => undefined),
    query: {
      properties: {
        findMany: mock(async () => [existingProperty]),
      },
    },
    insert: insertMock,
  };

  return {
    returningMock,
    tx: asTestRaw<Transaction>(tx),
  };
};

describe("collectTemplateProperties", () => {
  test("marks hidden dependency sources creatable without creating unrelated hidden columns", () => {
    const aiProperty = {
      id: "ai_summary",
      name: "Summary",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "ai-model", prompt: "Summarize" },
      system: false,
    } as const;
    const dependencyProperty = {
      id: "source_notes",
      name: "Source notes",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
      system: false,
    } as const;
    const unrelatedHiddenProperty = {
      id: "scratchpad",
      name: "Scratchpad",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
      system: false,
    } as const;
    const layout: ViewLayout = {
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [dependencyProperty.id, unrelatedHiddenProperty.id],
      columnOrder: [aiProperty.id],
      columnPinning: [],
    };

    const templateProperties = collectTemplateProperties({
      layout,
      properties: [aiProperty, dependencyProperty, unrelatedHiddenProperty],
      dependencies: [
        {
          propertyId: aiProperty.id,
          dependsOnPropertyId: dependencyProperty.id,
          condition: null,
        },
      ],
    });

    expect(templateProperties).toEqual([
      {
        version: 1,
        sourceId: aiProperty.id,
        name: aiProperty.name,
        content: aiProperty.content,
        tool: aiProperty.tool,
        createIfMissing: true,
        dependencies: [
          {
            dependsOnSourceId: dependencyProperty.id,
            condition: null,
          },
        ],
      },
      {
        version: 1,
        sourceId: dependencyProperty.id,
        name: dependencyProperty.name,
        content: dependencyProperty.content,
        tool: dependencyProperty.tool,
        createIfMissing: true,
      },
      {
        version: 1,
        sourceId: unrelatedHiddenProperty.id,
        name: unrelatedHiddenProperty.name,
        content: unrelatedHiddenProperty.content,
        tool: unrelatedHiddenProperty.tool,
        createIfMissing: false,
      },
    ]);
  });
});

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
      recordAuditEvent: noopAuditRecorder,
    });

    expect(result).toEqual({
      ok: false,
      status: 422,
      message: "File template columns must use manual input",
    });
    expect(insertMock).not.toHaveBeenCalled();
  });

  test("rejects duplicate template source IDs before inserting", async () => {
    const { executeMock, insertMock, tx } =
      createTemplatePropertyValidationTx();
    const templateProperty = {
      version: 1,
      sourceId: "source_duplicate",
      name: "Duplicate",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
      createIfMissing: true,
    } satisfies ViewTemplateProperty;

    const result = await resolveTemplateProperties({
      tx,
      workspaceId,
      layout: tableLayout(templateProperty.sourceId),
      templateProperties: [templateProperty, templateProperty],
      canCreateProperties: true,
      recordAuditEvent: noopAuditRecorder,
    });

    expect(result).toEqual({
      ok: false,
      status: 422,
      message: "Duplicate template property sourceId",
    });
    expect(executeMock).not.toHaveBeenCalled();
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
      recordAuditEvent: noopAuditRecorder,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: "Fallback must match one of the supplied options",
    });
    expect(insertMock).not.toHaveBeenCalled();
  });

  test("rejects cyclic dependencies between newly created template columns", async () => {
    const { dependencyValuesMock, executeMock, returningMock, tx } =
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
      recordAuditEvent: noopAuditRecorder,
    });

    expect(result).toEqual({
      ok: false,
      status: 422,
      message: "Circular template dependency detected",
    });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(returningMock).not.toHaveBeenCalled();
    expect(dependencyValuesMock).not.toHaveBeenCalled();
  });

  test("reuses existing shape matches only once", async () => {
    const { returningMock, tx } = createTemplateReuseTx();
    const firstProperty = {
      version: 1,
      sourceId: "source_a",
      name: "Status",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
      createIfMissing: true,
    } satisfies ViewTemplateProperty;
    const secondProperty = {
      ...firstProperty,
      sourceId: "source_b",
    } satisfies ViewTemplateProperty;
    const layout: ViewLayout = {
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      columnOrder: [firstProperty.sourceId, secondProperty.sourceId],
      columnPinning: [],
    };

    const result = await resolveTemplateProperties({
      tx,
      workspaceId,
      layout,
      templateProperties: [firstProperty, secondProperty],
      canCreateProperties: true,
      recordAuditEvent: noopAuditRecorder,
    });

    expect(result).toEqual({
      ok: true,
      layout: {
        ...layout,
        columnOrder: ["existing_property", "created_property"],
      },
      propertyIds: ["existing_property", "created_property"],
    });
    expect(returningMock).toHaveBeenCalledTimes(1);
  });
});
