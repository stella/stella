import { describe, expect, mock, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import { properties, propertyDependencies } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ViewLayout, ViewTemplateProperty } from "@/api/lib/views-schema";
import {
  collectTemplateProperties,
  resolveTemplateProperties,
} from "@/api/lib/views/template-properties";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const workspaceId = toSafeId<"workspace">("workspace_1");
const DOCUMENT_TYPE_CLASSIFIER_ROLE = "document-type-classifier";
const noopAuditRecorder: AuditRecorder = async () => {
  await Promise.resolve();
};

const tableLayout = (propertyId: string): ViewLayout => ({
  version: 1,
  type: "table",
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
  columnOrder: [propertyId],
  columnPinning: [],
});

const createDependencyOwnerSelect = (
  dependencies: readonly { propertyId: string }[] = [],
) =>
  mock(() => ({
    from: mock(() => ({
      where: mock(() => ({
        limit: mock(async () =>
          [...new Set(dependencies.map(({ propertyId }) => propertyId))].map(
            (propertyId) => ({ propertyId }),
          ),
        ),
      })),
    })),
  }));

const createTemplatePropertyValidationTx = () => {
  const insertMock = mock(() => {
    throw new Error("Unexpected template property insert");
  });
  const executeMock = mock(async () => undefined);
  const tx = {
    execute: executeMock,
    selectDistinct: createDependencyOwnerSelect(),
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
      propertyDependencies: {
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
  const propertyValuesMock = mock(
    (_rows: (typeof properties.$inferInsert)[]) => undefined,
  );
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
    selectDistinct: createDependencyOwnerSelect(),
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
      propertyDependencies: {
        findMany: mock(async () => []),
      },
    },
    insert: insertMock,
  };

  return {
    dependencyValuesMock,
    executeMock,
    propertyValuesMock,
    tx: asTestRaw<Transaction>(tx),
  };
};

type ExistingTemplateReuseProperty = {
  id: string;
  name: string;
  content: typeof properties.$inferSelect.content;
  tool: typeof properties.$inferSelect.tool;
  system?: boolean;
  role?: typeof properties.$inferSelect.role | undefined;
};

const defaultExistingTemplateReuseProperty = {
  id: "existing_property",
  name: "Status",
  content: { version: 1, type: "text" },
  tool: { version: 1, type: "manual-input" },
} satisfies ExistingTemplateReuseProperty;

const createTemplateReuseTx = (
  existingProperty:
    | ExistingTemplateReuseProperty
    | ExistingTemplateReuseProperty[] = defaultExistingTemplateReuseProperty,
  existingDependencies: {
    propertyId: string;
  }[] = [],
) => {
  const existingProperties = Array.isArray(existingProperty)
    ? existingProperty
    : [existingProperty];
  const propertyValuesMock = mock(
    (_rows: (typeof properties.$inferInsert)[]) => undefined,
  );
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
    selectDistinct: createDependencyOwnerSelect(existingDependencies),
    query: {
      properties: {
        findMany: mock(async () => {
          const rows: (ExistingTemplateReuseProperty & {
            role: typeof properties.$inferSelect.role | null;
            system: boolean;
          })[] = [];
          for (const property of existingProperties) {
            rows.push({
              id: property.id,
              name: property.name,
              content: property.content,
              tool: property.tool,
              system: property.system ?? false,
              role: property.role ?? null,
            });
          }
          return rows;
        }),
      },
      propertyDependencies: {
        findMany: mock(async () => existingDependencies),
      },
    },
    insert: insertMock,
  };

  /** Every column row the resolver wrote, in insert order. */
  const createdPropertyRows = (): (typeof properties.$inferInsert)[] =>
    propertyValuesMock.mock.calls.flatMap(([rows]) => rows);

  // The resolver mints column ids before writing, so the id it hands back is
  // only correct if it is the id it inserted. Reading the ids off the insert
  // is what pins that; a fixture id would pin the fixture instead.
  const createdPropertyIds = (): string[] =>
    createdPropertyRows().map((row) =>
      typeof row.id === "string" ? row.id : "",
    );

  return {
    createdPropertyIds,
    createdPropertyRows,
    propertyValuesMock,
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
      role: null,
    } as const;
    const dependencyProperty = {
      id: "source_notes",
      name: "Source notes",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
      system: false,
      role: null,
    } as const;
    const unrelatedHiddenProperty = {
      id: "scratchpad",
      name: "Scratchpad",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
      system: false,
      role: null,
    } as const;
    const layout: ViewLayout = {
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [dependencyProperty.id, unrelatedHiddenProperty.id],
      calculations: [],
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
        role: null,
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
        role: null,
        createIfMissing: true,
      },
      {
        version: 1,
        sourceId: unrelatedHiddenProperty.id,
        name: unrelatedHiddenProperty.name,
        content: unrelatedHiddenProperty.content,
        tool: unrelatedHiddenProperty.tool,
        role: null,
        createIfMissing: false,
      },
    ]);
  });

  test("preserves structural roles when exporting template columns", () => {
    const content = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const tool = {
      version: 1,
      type: "ai-model",
      prompt: "Classify the document type.",
    } satisfies ViewTemplateProperty["tool"];
    const classifier = {
      id: "document_type",
      name: "Type de document",
      content,
      tool,
      system: false,
      role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
    } satisfies Parameters<
      typeof collectTemplateProperties
    >[0]["properties"][number];

    const templateProperties = collectTemplateProperties({
      layout: tableLayout(classifier.id),
      properties: [classifier],
      dependencies: [],
    });

    expect(templateProperties).toEqual([
      expect.objectContaining({
        sourceId: classifier.id,
        role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      }),
    ]);
  });

  test("exports a unique unbackfilled legacy classifier with its structural role", () => {
    const content = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const classifier = {
      id: "document_type",
      name: "Document Type",
      content,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the document type.",
      },
      system: false,
      role: null,
    } satisfies Parameters<
      typeof collectTemplateProperties
    >[0]["properties"][number];

    const templateProperties = collectTemplateProperties({
      layout: tableLayout(classifier.id),
      properties: [classifier],
      dependencies: [],
    });

    expect(templateProperties).toEqual([
      expect.objectContaining({
        sourceId: classifier.id,
        role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      }),
    ]);
  });

  test("keeps duplicate unbackfilled legacy classifiers roleless on export", () => {
    const content = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const first = {
      id: "document_type",
      name: "Document Type",
      content,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the document type.",
      },
      system: false,
      role: null,
    } satisfies Parameters<
      typeof collectTemplateProperties
    >[0]["properties"][number];
    const second = {
      ...first,
      id: "document_type_duplicate",
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the duplicate document type.",
      },
    } satisfies Parameters<
      typeof collectTemplateProperties
    >[0]["properties"][number];

    const templateProperties = collectTemplateProperties({
      layout: tableLayout(first.id),
      properties: [first, second],
      dependencies: [],
    });

    expect(templateProperties).toEqual([
      expect.objectContaining({
        sourceId: first.id,
        role: null,
      }),
      expect.objectContaining({
        sourceId: second.id,
        role: null,
      }),
    ]);
  });

  test("serializes explicit role absence for ordinary document type duplicates", () => {
    const content = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const duplicate = {
      id: "ordinary_document_type",
      name: "Document Type",
      content,
      tool: { version: 1, type: "manual-input" },
      system: false,
      role: null,
    } satisfies Parameters<
      typeof collectTemplateProperties
    >[0]["properties"][number];

    const templateProperties = collectTemplateProperties({
      layout: tableLayout(duplicate.id),
      properties: [duplicate],
      dependencies: [],
    });

    expect(templateProperties).toEqual([
      expect.objectContaining({
        sourceId: duplicate.id,
        role: null,
      }),
    ]);
  });
});

const rejectionOf = async (
  pending: Promise<unknown>,
): Promise<HandlerError> => {
  const outcome = await pending.then(
    () => null,
    (error: unknown) => error,
  );
  if (!HandlerError.is(outcome)) {
    throw new Error("resolveTemplateProperties resolved instead of rejecting");
  }
  return outcome;
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

    const rejection = await rejectionOf(
      resolveTemplateProperties({
        tx,
        workspaceId,
        layout: tableLayout(templateProperty.sourceId),
        templateProperties: [templateProperty],
        canCreateProperties: true,
        recordAuditEvent: noopAuditRecorder,
      }),
    );

    expect(rejection.status).toBe(422);
    expect(rejection.message).toBe(
      "File template columns must use manual input",
    );
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

    const rejection = await rejectionOf(
      resolveTemplateProperties({
        tx,
        workspaceId,
        layout: tableLayout(templateProperty.sourceId),
        templateProperties: [templateProperty, templateProperty],
        canCreateProperties: true,
        recordAuditEvent: noopAuditRecorder,
      }),
    );

    expect(rejection.status).toBe(422);
    expect(rejection.message).toBe("Duplicate template property sourceId");
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

    const rejection = await rejectionOf(
      resolveTemplateProperties({
        tx,
        workspaceId,
        layout: tableLayout(templateProperty.sourceId),
        templateProperties: [templateProperty],
        canCreateProperties: true,
        recordAuditEvent: noopAuditRecorder,
      }),
    );

    expect(rejection.status).toBe(400);
    expect(rejection.message).toBe(
      "Fallback must match one of the supplied options",
    );
    expect(insertMock).not.toHaveBeenCalled();
  });

  test("rejects cyclic dependencies between newly created template columns", async () => {
    const { dependencyValuesMock, executeMock, propertyValuesMock, tx } =
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

    const rejection = await rejectionOf(
      resolveTemplateProperties({
        tx,
        workspaceId,
        layout: tableLayout(propertyA.sourceId),
        templateProperties: [propertyA, propertyB],
        canCreateProperties: true,
        recordAuditEvent: noopAuditRecorder,
      }),
    );

    expect(rejection.status).toBe(422);
    expect(rejection.message).toBe("Circular template dependency detected");
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(propertyValuesMock).not.toHaveBeenCalled();
    expect(dependencyValuesMock).not.toHaveBeenCalled();
  });

  test("reuses existing shape matches only once", async () => {
    const { createdPropertyIds, tx } = createTemplateReuseTx();
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
      calculations: [],
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

    expect(createdPropertyIds()).toHaveLength(1);
    const [createdId] = createdPropertyIds();
    if (createdId === undefined) {
      throw new TypeError("Expected the resolver to create one column");
    }
    expect(result).toEqual({
      layout: {
        ...layout,
        columnOrder: ["existing_property", createdId],
      },
      propertyIds: ["existing_property", createdId],
    });
  });

  test("does not reuse AI shape matches when either side has dependencies", async () => {
    const { createdPropertyIds, tx } = createTemplateReuseTx(
      {
        id: "existing_property",
        name: "Summary",
        content: { version: 1, type: "text" },
        tool: { version: 1, type: "ai-model", prompt: "Summarize" },
      },
      [{ propertyId: "existing_property" }],
    );
    const templateProperty = {
      version: 1,
      sourceId: "source_summary",
      name: "Summary",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "ai-model", prompt: "Summarize" },
      createIfMissing: true,
    } satisfies ViewTemplateProperty;
    const layout: ViewLayout = {
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      calculations: [],
      columnOrder: [templateProperty.sourceId],
      columnPinning: [],
    };

    const result = await resolveTemplateProperties({
      tx,
      workspaceId,
      layout,
      templateProperties: [templateProperty],
      canCreateProperties: true,
      recordAuditEvent: noopAuditRecorder,
    });

    expect(createdPropertyIds()).toHaveLength(1);
    const [createdId] = createdPropertyIds();
    if (createdId === undefined) {
      throw new TypeError("Expected the resolver to create one column");
    }
    expect(result).toEqual({
      layout: {
        ...layout,
        columnOrder: [createdId],
      },
      propertyIds: ["existing_property", createdId],
    });
  });

  test("sanitizes AI prompt markup before persisting template-created columns", async () => {
    const { createdPropertyIds, createdPropertyRows, tx } =
      createTemplateReuseTx({
        id: "existing_property",
        name: "Other",
        content: { version: 1, type: "text" },
        tool: { version: 1, type: "manual-input" },
      });
    const templateProperty = {
      version: 1,
      sourceId: "source_unsafe_ai",
      name: "Unsafe",
      content: { version: 1, type: "text" },
      tool: {
        version: 1,
        type: "ai-model",
        prompt: '<script>alert("xss")</script><b>Bold</b>',
      },
      createIfMissing: true,
    } satisfies ViewTemplateProperty;

    await resolveTemplateProperties({
      tx,
      workspaceId,
      layout: tableLayout(templateProperty.sourceId),
      templateProperties: [templateProperty],
      canCreateProperties: true,
      recordAuditEvent: noopAuditRecorder,
    });

    expect(createdPropertyIds()).toHaveLength(1);
    const persistedTool = createdPropertyRows().at(0)?.tool;
    expect(persistedTool?.type).toBe("ai-model");
    const prompt =
      persistedTool?.type === "ai-model" ? persistedTool.prompt : "";
    expect(prompt).not.toContain("<script>");
    expect(prompt).toContain("**Bold**");
  });

  test("preserves structural roles when creating template columns", async () => {
    const content = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const tool = {
      version: 1,
      type: "ai-model",
      prompt: "Classify the document type.",
    } satisfies ViewTemplateProperty["tool"];
    const { createdPropertyIds, createdPropertyRows, tx } =
      createTemplateReuseTx({
        id: "existing_property",
        name: "Type de document",
        content,
        tool,
        role: null,
      });
    const templateProperty = {
      version: 1,
      sourceId: "source_document_type",
      name: "Type de document",
      content,
      tool,
      role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      createIfMissing: true,
    } satisfies ViewTemplateProperty;

    await resolveTemplateProperties({
      tx,
      workspaceId,
      layout: tableLayout(templateProperty.sourceId),
      templateProperties: [templateProperty],
      canCreateProperties: true,
      recordAuditEvent: noopAuditRecorder,
    });

    expect(createdPropertyIds()).toHaveLength(1);
    expect(createdPropertyRows().at(0)).toEqual(
      expect.objectContaining({
        role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      }),
    );
  });

  test("rejects structural roles on non-classifier templates", async () => {
    const { propertyValuesMock, tx } = createTemplateReuseTx();
    const templateProperty = {
      version: 1,
      sourceId: "source_notes",
      name: "Notes",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
      role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      createIfMissing: true,
    } satisfies ViewTemplateProperty;

    const rejection = await rejectionOf(
      resolveTemplateProperties({
        tx,
        workspaceId,
        layout: tableLayout(templateProperty.sourceId),
        templateProperties: [templateProperty],
        canCreateProperties: true,
        recordAuditEvent: noopAuditRecorder,
      }),
    );

    expect(rejection.status).toBe(422);
    expect(rejection.message).toBe(
      "Document type classifier templates must be AI single-select columns",
    );
    expect(propertyValuesMock).not.toHaveBeenCalled();
  });

  test("rejects duplicate classifier roles in one template payload", async () => {
    const { insertMock, tx } = createTemplatePropertyValidationTx();
    const content = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const tool = {
      version: 1,
      type: "ai-model",
      prompt: "Classify the document type.",
    } satisfies ViewTemplateProperty["tool"];
    const rejection = await rejectionOf(
      resolveTemplateProperties({
        tx,
        workspaceId,
        layout: tableLayout("source_document_type_a"),
        templateProperties: [
          {
            version: 1,
            sourceId: "source_document_type_a",
            name: "Document Type",
            content,
            tool,
            role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
            createIfMissing: true,
          },
          {
            version: 1,
            sourceId: "source_document_type_b",
            name: "Type de document",
            content,
            tool,
            role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
            createIfMissing: true,
          },
        ],
        canCreateProperties: true,
        recordAuditEvent: noopAuditRecorder,
      }),
    );

    expect(rejection.status).toBe(422);
    expect(rejection.message).toBe("Duplicate template property role");
    expect(insertMock).not.toHaveBeenCalled();
  });

  test("reuses structural role matches before shape matches", async () => {
    const templateContent = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const { propertyValuesMock, tx } = createTemplateReuseTx({
      id: "existing_property",
      name: "Dokumenttyp",
      content: {
        version: 1,
        type: "single-select",
        options: [{ color: "green", value: "Invoice" }],
        fallback: null,
      },
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify localized document types.",
      },
      role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
    });
    const templateProperty = {
      version: 1,
      sourceId: "source_document_type",
      name: "Type de document",
      content: templateContent,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the document type.",
      },
      role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      createIfMissing: true,
    } satisfies ViewTemplateProperty;
    const layout = tableLayout(templateProperty.sourceId);

    const result = await resolveTemplateProperties({
      tx,
      workspaceId,
      layout,
      templateProperties: [templateProperty],
      canCreateProperties: true,
      recordAuditEvent: noopAuditRecorder,
    });

    expect(result).toEqual({
      layout: tableLayout("existing_property"),
      propertyIds: ["existing_property"],
    });
    expect(propertyValuesMock).not.toHaveBeenCalled();
  });

  test("falls through exact-id reuse for stale role-bearing templates", async () => {
    const templateContent = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const { propertyValuesMock, tx } = createTemplateReuseTx([
      {
        id: "source_document_type",
        name: "Document Type",
        content: { version: 1, type: "text" },
        tool: { version: 1, type: "manual-input" },
        role: null,
      },
      {
        id: "tagged_classifier",
        name: "Type de document",
        content: templateContent,
        tool: {
          version: 1,
          type: "ai-model",
          prompt: "Classify the document type.",
        },
        role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      },
    ]);
    const templateProperty = {
      version: 1,
      sourceId: "source_document_type",
      name: "Document Type",
      content: templateContent,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the document type.",
      },
      role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
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
      layout: tableLayout("tagged_classifier"),
      propertyIds: ["source_document_type", "tagged_classifier"],
    });
    expect(propertyValuesMock).not.toHaveBeenCalled();
  });

  test("falls through exact-id reuse for stale inferred legacy classifiers", async () => {
    const templateContent = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const { propertyValuesMock, tx } = createTemplateReuseTx([
      {
        id: "source_document_type",
        name: "Document Type",
        content: { version: 1, type: "text" },
        tool: { version: 1, type: "manual-input" },
        role: null,
      },
      {
        id: "tagged_classifier",
        name: "Type de document",
        content: templateContent,
        tool: {
          version: 1,
          type: "ai-model",
          prompt: "Classify the document type.",
        },
        role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      },
    ]);
    const templateProperty = {
      version: 1,
      sourceId: "source_document_type",
      name: "Document Type",
      content: templateContent,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the document type.",
      },
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
      layout: tableLayout("tagged_classifier"),
      propertyIds: ["source_document_type", "tagged_classifier"],
    });
    expect(propertyValuesMock).not.toHaveBeenCalled();
  });

  test("reuses legacy classifiers for explicit role templates", async () => {
    const templateContent = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const { propertyValuesMock, tx } = createTemplateReuseTx({
      id: "existing_property",
      name: "Document Type",
      content: templateContent,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify existing document types.",
      },
      role: null,
    });
    const templateProperty = {
      version: 1,
      sourceId: "source_document_type",
      name: "Document Type",
      content: templateContent,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the document type.",
      },
      role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
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
      layout: tableLayout("existing_property"),
      propertyIds: ["existing_property"],
    });
    expect(propertyValuesMock).not.toHaveBeenCalled();
  });

  test("rejects malformed structural role matches", async () => {
    const templateContent = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const { propertyValuesMock, tx } = createTemplateReuseTx({
      id: "existing_property",
      name: "Document Type",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
      role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
    });
    const templateProperty = {
      version: 1,
      sourceId: "existing_property",
      name: "Document Type",
      content: templateContent,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the document type.",
      },
      role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      createIfMissing: true,
    } satisfies ViewTemplateProperty;

    const rejection = await rejectionOf(
      resolveTemplateProperties({
        tx,
        workspaceId,
        layout: tableLayout(templateProperty.sourceId),
        templateProperties: [templateProperty],
        canCreateProperties: true,
        recordAuditEvent: noopAuditRecorder,
      }),
    );

    expect(rejection.status).toBe(422);
    expect(rejection.message).toBe(
      "Document type classifier role is attached to an incompatible column",
    );
    expect(propertyValuesMock).not.toHaveBeenCalled();
  });

  test("reuses role-tagged classifiers for legacy roleless templates", async () => {
    const templateContent = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const { propertyValuesMock, tx } = createTemplateReuseTx({
      id: "existing_property",
      name: "Type de document",
      content: templateContent,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify localized document types.",
      },
      role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
    });
    const templateProperty = {
      version: 1,
      sourceId: "source_document_type",
      name: "Document Type",
      content: templateContent,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the document type.",
      },
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
      layout: tableLayout("existing_property"),
      propertyIds: ["existing_property"],
    });
    expect(propertyValuesMock).not.toHaveBeenCalled();
  });

  test("reuses roleless legacy classifiers for legacy roleless templates", async () => {
    const templateContent = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const templateTool = {
      version: 1,
      type: "ai-model",
      prompt: "Classify the document type.",
    } satisfies ViewTemplateProperty["tool"];
    const { propertyValuesMock, tx } = createTemplateReuseTx({
      id: "existing_property",
      name: "Document Type",
      content: templateContent,
      tool: templateTool,
      role: null,
    });
    const templateProperty = {
      version: 1,
      sourceId: "source_document_type",
      name: "Document Type",
      content: templateContent,
      tool: templateTool,
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
      layout: tableLayout("existing_property"),
      propertyIds: ["existing_property"],
    });
    expect(propertyValuesMock).not.toHaveBeenCalled();
  });

  test("tags legacy roleless classifier templates when creating", async () => {
    const templateContent = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const { createdPropertyIds, createdPropertyRows, tx } =
      createTemplateReuseTx();
    const templateProperty = {
      version: 1,
      sourceId: "source_document_type",
      name: "Document Type",
      content: templateContent,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the document type.",
      },
      createIfMissing: true,
    } satisfies ViewTemplateProperty;

    await resolveTemplateProperties({
      tx,
      workspaceId,
      layout: tableLayout(templateProperty.sourceId),
      templateProperties: [templateProperty],
      canCreateProperties: true,
      recordAuditEvent: noopAuditRecorder,
    });

    expect(createdPropertyIds()).toHaveLength(1);
    expect(createdPropertyRows().at(0)).toEqual(
      expect.objectContaining({
        role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      }),
    );
  });

  test("keeps explicit roleless document type templates ordinary when creating", async () => {
    const templateContent = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const { createdPropertyIds, createdPropertyRows, tx } =
      createTemplateReuseTx();
    const templateProperty = {
      version: 1,
      sourceId: "source_document_type",
      name: "Document Type",
      content: templateContent,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the document type.",
      },
      role: null,
      createIfMissing: true,
    } satisfies ViewTemplateProperty;

    await resolveTemplateProperties({
      tx,
      workspaceId,
      layout: tableLayout(templateProperty.sourceId),
      templateProperties: [templateProperty],
      canCreateProperties: true,
      recordAuditEvent: noopAuditRecorder,
    });

    expect(createdPropertyIds()).toHaveLength(1);
    expect(createdPropertyRows().at(0)).toEqual(
      expect.objectContaining({
        role: null,
      }),
    );
  });

  test("allows explicit roleless ordinary templates when creating", async () => {
    const { createdPropertyIds, createdPropertyRows, tx } =
      createTemplateReuseTx();
    const templateProperty = {
      version: 1,
      sourceId: "source_notes",
      name: "Notes",
      content: { version: 1, type: "text" },
      tool: { version: 1, type: "manual-input" },
      role: null,
      createIfMissing: true,
    } satisfies ViewTemplateProperty;

    await resolveTemplateProperties({
      tx,
      workspaceId,
      layout: tableLayout(templateProperty.sourceId),
      templateProperties: [templateProperty],
      canCreateProperties: true,
      recordAuditEvent: noopAuditRecorder,
    });

    expect(createdPropertyIds()).toHaveLength(1);
    expect(createdPropertyRows().at(0)).toEqual(
      expect.objectContaining({
        role: null,
      }),
    );
  });

  test("keeps roleless legacy duplicates ordinary when an explicit classifier exists", async () => {
    const templateContent = {
      version: 1,
      type: "single-select",
      options: [{ color: "blue", value: "Contract" }],
      fallback: null,
    } satisfies ViewTemplateProperty["content"];
    const { createdPropertyIds, createdPropertyRows, tx } =
      createTemplateReuseTx();
    const explicitClassifier = {
      version: 1,
      sourceId: "source_document_type_tagged",
      name: "Type de document",
      content: templateContent,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the document type.",
      },
      role: DOCUMENT_TYPE_CLASSIFIER_ROLE,
      createIfMissing: true,
    } satisfies ViewTemplateProperty;
    const legacyDuplicate = {
      version: 1,
      sourceId: "source_document_type_legacy",
      name: "Document Type",
      content: templateContent,
      tool: {
        version: 1,
        type: "ai-model",
        prompt: "Classify the duplicate document type.",
      },
      createIfMissing: true,
    } satisfies ViewTemplateProperty;
    const layout: ViewLayout = {
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      calculations: [],
      columnOrder: [explicitClassifier.sourceId, legacyDuplicate.sourceId],
      columnPinning: [],
    };

    await resolveTemplateProperties({
      tx,
      workspaceId,
      layout,
      templateProperties: [explicitClassifier, legacyDuplicate],
      canCreateProperties: true,
      recordAuditEvent: noopAuditRecorder,
    });

    expect(createdPropertyIds()).toHaveLength(2);
    expect(createdPropertyRows().map(({ role }) => role)).toEqual([
      DOCUMENT_TYPE_CLASSIFIER_ROLE,
      null,
    ]);
  });

  test("does not reuse shape matches with different config", async () => {
    const { createdPropertyIds, tx } = createTemplateReuseTx({
      id: "existing_property",
      name: "Status",
      content: {
        version: 1,
        type: "single-select",
        options: [{ color: "green", value: "Open" }],
        fallback: "Open",
      },
      tool: { version: 1, type: "manual-input" },
    });
    const templateProperty = {
      version: 1,
      sourceId: "source_status",
      name: "Status",
      content: {
        version: 1,
        type: "single-select",
        options: [{ color: "red", value: "Closed" }],
        fallback: "Closed",
      },
      tool: { version: 1, type: "manual-input" },
      createIfMissing: true,
    } satisfies ViewTemplateProperty;
    const layout: ViewLayout = {
      version: 1,
      type: "table",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      calculations: [],
      columnOrder: [templateProperty.sourceId],
      columnPinning: [],
    };

    const result = await resolveTemplateProperties({
      tx,
      workspaceId,
      layout,
      templateProperties: [templateProperty],
      canCreateProperties: true,
      recordAuditEvent: noopAuditRecorder,
    });

    expect(createdPropertyIds()).toHaveLength(1);
    const [createdId] = createdPropertyIds();
    if (createdId === undefined) {
      throw new TypeError("Expected the resolver to create one column");
    }
    expect(result).toEqual({
      layout: {
        ...layout,
        columnOrder: [createdId],
      },
      propertyIds: ["existing_property", createdId],
    });
  });
});
