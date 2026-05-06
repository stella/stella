import type { Result } from "better-result";
import * as v from "valibot";

import { ENTITY_KINDS, PROPERTY_STATUSES } from "@/api/db/schema";
import {
  buildItemsOutputSchema,
  buildPaginatedOutputSchema,
  paginationInputEntries,
} from "@/api/handlers/chat/tools/execute/pagination";
import {
  buildReadonlyFunctionManifest,
  buildReadonlyFunctionTypeDeclarations,
  createReadonlyFunctionContract,
} from "@/api/handlers/chat/tools/execute/readonly-manifest";
import type {
  ReadonlyFunctionContract,
  ReadonlyFunctionManifest,
} from "@/api/handlers/chat/tools/execute/readonly-manifest";
import type { ChatToolValidationError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const entityKindSchema = v.picklist(ENTITY_KINDS);
const propertyStatusSchema = v.picklist(PROPERTY_STATUSES);
const matterRefSchema = v.pipe(
  v.string(),
  v.regex(/^mat_\d+$/),
  v.description("Short matter ref returned by Stella tools"),
);
const entityRefSchema = v.pipe(
  v.string(),
  v.regex(/^ent_\d+$/),
  v.description("Short entity ref returned by Stella tools"),
);
const propertyRefSchema = v.pipe(
  v.string(),
  v.regex(/^prop_\d+$/),
  v.description("Short property ref returned by Stella tools"),
);
const storedFileIdSchema = v.pipe(
  v.string(),
  v.uuid(),
  v.description("File ID"),
);

const matterRefsSchema = v.pipe(
  v.array(matterRefSchema),
  v.minLength(1),
  v.maxLength(LIMITS.chatExecuteDetailIdsMax),
  v.description("Matter refs to inspect"),
);

const entityRefsSchema = v.pipe(
  v.array(entityRefSchema),
  v.minLength(1),
  v.maxLength(LIMITS.chatExecuteDetailIdsMax),
  v.description("Entity refs to inspect"),
);

const propertyRefsSchema = v.pipe(
  v.array(propertyRefSchema),
  v.minLength(1),
  v.maxLength(LIMITS.chatExecuteDetailIdsMax),
  v.description("Property refs to inspect"),
);

const contentEntityRefsSchema = v.pipe(
  v.array(entityRefSchema),
  v.minLength(1),
  v.maxLength(LIMITS.chatExecuteContentIdsMax),
  v.description("Entity refs whose extracted content should be read"),
);

const propertyOptionSchema = v.strictObject({
  color: v.pipe(v.string(), v.description("Option color token")),
  value: v.pipe(v.string(), v.description("Option value")),
});

const propertyContentSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("file"),
    version: v.number(),
  }),
  v.strictObject({
    type: v.literal("text"),
    version: v.number(),
  }),
  v.strictObject({
    fallback: v.nullable(v.pipe(v.string(), v.description("Fallback option"))),
    options: v.array(propertyOptionSchema),
    type: v.literal("single-select"),
    version: v.number(),
  }),
  v.strictObject({
    fallback: v.nullable(v.pipe(v.string(), v.description("Fallback option"))),
    options: v.array(propertyOptionSchema),
    type: v.literal("multi-select"),
    version: v.number(),
  }),
  v.strictObject({
    type: v.literal("date"),
    version: v.number(),
  }),
  v.strictObject({
    type: v.literal("int"),
    version: v.number(),
  }),
]);

const propertyToolSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("manual-input"),
    version: v.number(),
  }),
  v.strictObject({
    dependencies: v.array(
      v.strictObject({
        condition: v.nullable(v.unknown()),
        dependsOnPropertyRef: propertyRefSchema,
      }),
    ),
    prompt: v.pipe(v.string(), v.description("AI tool prompt")),
    type: v.literal("ai-model"),
    version: v.number(),
  }),
]);

const sourceDocumentSchema = v.strictObject({
  entityId: v.pipe(v.string(), v.uuid(), v.description("Source entity ID")),
  entityRef: entityRefSchema,
  kind: v.pipe(v.string(), v.description("Source entity kind")),
  matterRef: matterRefSchema,
  mention: v.pipe(
    v.string(),
    v.description("Markdown mention to copy when citing this source document"),
  ),
  mimeType: v.nullable(v.pipe(v.string(), v.description("Source MIME type"))),
  title: v.pipe(v.string(), v.description("Source document title")),
  workspaceId: v.nullable(
    v.pipe(v.string(), v.uuid(), v.description("Source workspace ID")),
  ),
});

/** Mirrors `fieldContentSchema` in `@/api/db/schema-validators` for tool output. */
const fieldVersionSchema = v.literal(1);

const pdfDerivativeSchema = v.optional(
  v.variant("status", [
    v.strictObject({
      status: v.literal("failed"),
    }),
    v.strictObject({
      status: v.literal("not-required"),
    }),
    v.strictObject({
      status: v.literal("pending"),
    }),
    v.strictObject({
      status: v.literal("ready"),
    }),
  ]),
);

const fieldContentSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("error"),
    version: fieldVersionSchema,
  }),
  v.strictObject({
    type: v.literal("pending"),
    version: fieldVersionSchema,
  }),
  v.strictObject({
    type: v.literal("unsupported"),
    version: fieldVersionSchema,
  }),
  v.strictObject({
    encrypted: v.boolean(),
    fileName: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    id: storedFileIdSchema,
    mimeType: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
    pdfDerivative: pdfDerivativeSchema,
    pdfFileId: v.nullable(storedFileIdSchema),
    scanWarnings: v.optional(v.array(v.pipe(v.string(), v.maxLength(256)))),
    sha256Hex: v.pipe(v.string(), v.minLength(64), v.maxLength(64)),
    sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
    type: v.literal("file"),
    version: fieldVersionSchema,
  }),
  v.strictObject({
    type: v.literal("text"),
    value: v.pipe(v.string(), v.minLength(1)),
    version: fieldVersionSchema,
  }),
  v.strictObject({
    type: v.literal("single-select"),
    value: v.nullable(v.pipe(v.string(), v.minLength(1))),
    version: fieldVersionSchema,
  }),
  v.strictObject({
    type: v.literal("multi-select"),
    value: v.array(v.pipe(v.string(), v.minLength(1))),
    version: fieldVersionSchema,
  }),
  v.strictObject({
    type: v.literal("date"),
    value: v.nullable(v.pipe(v.string(), v.isoDate())),
    version: fieldVersionSchema,
  }),
  v.strictObject({
    currency: v.nullable(v.pipe(v.string(), v.minLength(3), v.maxLength(3))),
    type: v.literal("int"),
    value: v.pipe(v.number(), v.integer()),
    version: fieldVersionSchema,
  }),
  v.strictObject({
    citation: v.optional(v.pipe(v.string(), v.maxLength(1000))),
    jurisdiction: v.optional(v.pipe(v.string(), v.maxLength(128))),
    snippet: v.optional(v.pipe(v.string(), v.maxLength(10_000))),
    sourceType: v.optional(v.pipe(v.string(), v.maxLength(64))),
    type: v.literal("clip"),
    url: v.pipe(v.string(), v.maxLength(2048)),
    version: fieldVersionSchema,
  }),
]);

const entityFieldItemSchema = v.strictObject({
  content: fieldContentSchema,
  propertyRef: propertyRefSchema,
});

const propertySummaryEntries = {
  matterRef: matterRefSchema,
  name: v.pipe(v.string(), v.description("Property name")),
  propertyRef: propertyRefSchema,
  status: propertyStatusSchema,
  type: v.pipe(v.string(), v.description("Property content type")),
} as const;

const propertySummarySchema = v.strictObject(propertySummaryEntries);

const propertyDetailSchema = v.strictObject({
  ...propertySummaryEntries,
  content: propertyContentSchema,
  createdAt: v.pipe(v.string(), v.description("ISO timestamp")),
  tool: propertyToolSchema,
});

const entitySummaryEntries = {
  entityRef: entityRefSchema,
  fields: v.array(entityFieldItemSchema),
  kind: entityKindSchema,
  matterRef: matterRefSchema,
  mention: v.pipe(
    v.string(),
    v.description("Markdown mention to copy when referring to this entity"),
  ),
  name: v.pipe(v.string(), v.description("Entity name")),
  parentRef: v.nullable(
    v.pipe(v.string(), v.description("Parent folder entity ref")),
  ),
} as const;

const entitySummarySchema = v.strictObject(entitySummaryEntries);

const entityDetailSchema = v.strictObject({
  ...entitySummaryEntries,
  createdAt: v.pipe(v.string(), v.description("ISO timestamp")),
  createdBy: v.nullable(v.pipe(v.string(), v.description("Creator name"))),
  sourceDocument: sourceDocumentSchema,
  versionCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

const entityContentSchema = v.strictObject({
  charCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  entityRef: entityRefSchema,
  matterRef: matterRefSchema,
  mention: v.pipe(
    v.string(),
    v.description("Markdown mention to copy when referring to this entity"),
  ),
  name: v.nullable(v.pipe(v.string(), v.description("Entity name"))),
  sourceDocument: sourceDocumentSchema,
  text: v.pipe(v.string(), v.description("Extracted text content")),
  truncated: v.pipe(
    v.boolean(),
    v.description("Whether the text was truncated"),
  ),
});

const listMatterPropertiesInputSchema = v.strictObject({
  matterRefs: matterRefsSchema,
  ...paginationInputEntries,
});

const getMatterPropertiesInputSchema = v.strictObject({
  matterRefs: matterRefsSchema,
  propertyRefs: propertyRefsSchema,
});

const listMatterEntitiesInputSchema = v.strictObject({
  kind: v.optional(
    v.pipe(entityKindSchema, v.description("Optional entity kind filter")),
  ),
  matterRefs: matterRefsSchema,
  parentRef: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^ent_\d+$/),
      v.description("Optional parent folder entity ref"),
    ),
  ),
  ...paginationInputEntries,
});

const getMatterEntitiesInputSchema = v.strictObject({
  entityRefs: entityRefsSchema,
  matterRefs: matterRefsSchema,
});

const getMatterEntityContentsInputSchema = v.strictObject({
  entityRefs: contentEntityRefsSchema,
  matterRefs: matterRefsSchema,
});

export const listMatterPropertiesContract = createReadonlyFunctionContract({
  summary: "List compact property summaries for one or more matters.",
  input: listMatterPropertiesInputSchema,
  name: "listMatterProperties",
  output: buildPaginatedOutputSchema(propertySummarySchema),
});

export const getMatterPropertiesContract = createReadonlyFunctionContract({
  summary:
    "Get full property definitions, including property content and tool configuration, for known property refs in known matters.",
  input: getMatterPropertiesInputSchema,
  name: "getMatterProperties",
  output: buildItemsOutputSchema(propertyDetailSchema),
});

export const listMatterEntitiesContract = createReadonlyFunctionContract({
  summary: "List compact entity summaries for one or more matters.",
  details:
    "Use returned refs for follow-up calls. Reference entities in user-facing answers with markdown links like `[Name](#stella-entity-ref=ent_1)`. Each field's `content` is the stored value discriminated union (same shape as the DB). Resolve property display names via `listMatterProperties` or `getMatterProperties`. Supports optional kind and parent filters.",
  input: listMatterEntitiesInputSchema,
  name: "listMatterEntities",
  output: buildPaginatedOutputSchema(entitySummarySchema),
});

export const getMatterEntitiesContract = createReadonlyFunctionContract({
  summary: "Get rich entity details for known entity refs in known matters.",
  details:
    "Use refs for follow-up calls. Reference entities in user-facing answers with markdown links like `[Name](#stella-entity-ref=ent_1)`. Each field's `content` is the stored value discriminated union (same shape as the DB). Resolve property display names via `listMatterProperties` or `getMatterProperties`.",
  input: getMatterEntitiesInputSchema,
  name: "getMatterEntities",
  output: buildItemsOutputSchema(entityDetailSchema),
});

export const getMatterEntityContentsContract = createReadonlyFunctionContract({
  summary: "Get extracted text content for known entity refs in known matters.",
  details: "Text is truncated server-side when needed.",
  input: getMatterEntityContentsInputSchema,
  name: "getMatterEntityContents",
  output: buildItemsOutputSchema(entityContentSchema),
});

export const readonlyWorkspaceFunctionContracts = [
  listMatterPropertiesContract,
  getMatterPropertiesContract,
  listMatterEntitiesContract,
  getMatterEntitiesContract,
  getMatterEntityContentsContract,
] as const satisfies readonly ReadonlyFunctionContract[];

export type ReadonlyWorkspaceFunctionName =
  (typeof readonlyWorkspaceFunctionContracts)[number]["name"];

export const buildReadonlyWorkspaceFunctionManifest = (): Result<
  ReadonlyFunctionManifest[],
  ChatToolValidationError
> => buildReadonlyFunctionManifest(readonlyWorkspaceFunctionContracts);

export const buildReadonlyWorkspaceFnTypes = () =>
  buildReadonlyFunctionTypeDeclarations(readonlyWorkspaceFunctionContracts);
