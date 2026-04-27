import type { Result } from "better-result";
import * as v from "valibot";

import { entityKindEnum, propertyStatusEnum } from "@/api/db/schema";
import {
  buildPaginatedOutputSchema,
  paginationInputEntries,
} from "@/api/handlers/chat/tools/execute/pagination";
import {
  buildReadonlyFunctionManifest,
  buildReadonlyFunctionTypeDeclarations,
  createReadonlyFunctionContract,
} from "@/api/handlers/chat/tools/execute/readonly-manifest";
import type { ReadonlyFunctionManifest } from "@/api/handlers/chat/tools/execute/readonly-manifest";
import type { ChatToolValidationError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const entityKindSchema = v.picklist(entityKindEnum.enumValues);
const propertyStatusSchema = v.picklist(propertyStatusEnum.enumValues);
const matterIdSchema = v.pipe(v.string(), v.uuid(), v.description("Matter ID"));
const entityIdSchema = v.pipe(v.string(), v.uuid(), v.description("Entity ID"));
const propertyIdSchema = v.pipe(
  v.string(),
  v.uuid(),
  v.description("Property ID"),
);

const matterIdsSchema = v.pipe(
  v.array(matterIdSchema),
  v.minLength(1),
  v.maxLength(LIMITS.chatExecuteDetailIdsMax),
  v.description("Matter IDs to inspect"),
);

const entityIdsSchema = v.pipe(
  v.array(entityIdSchema),
  v.minLength(1),
  v.maxLength(LIMITS.chatExecuteDetailIdsMax),
  v.description("Entity IDs to inspect"),
);

const propertyIdsSchema = v.pipe(
  v.array(propertyIdSchema),
  v.minLength(1),
  v.maxLength(LIMITS.chatExecuteDetailIdsMax),
  v.description("Property IDs to inspect"),
);

const contentEntityIdsSchema = v.pipe(
  v.array(entityIdSchema),
  v.minLength(1),
  v.maxLength(LIMITS.chatExecuteContentIdsMax),
  v.description("Entity IDs whose extracted content should be read"),
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
        dependsOnPropertyId: propertyIdSchema,
      }),
    ),
    prompt: v.pipe(v.string(), v.description("AI tool prompt")),
    type: v.literal("ai-model"),
    version: v.number(),
  }),
]);

const sourceDocumentSchema = v.strictObject({
  entityId: entityIdSchema,
  kind: v.pipe(v.string(), v.description("Source entity kind")),
  mimeType: v.nullable(v.pipe(v.string(), v.description("Source MIME type"))),
  title: v.pipe(v.string(), v.description("Source document title")),
  workspaceId: v.nullable(
    v.pipe(v.string(), v.description("Workspace ID for the source document")),
  ),
});

/** Mirrors `fieldContentSchema` in `@/api/db/schema-validators` for tool output. */
const fieldVersionSchema = v.literal(1);

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
    id: v.pipe(v.string(), v.minLength(21), v.maxLength(21)),
    mimeType: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
    pdfFileId: v.nullable(v.pipe(v.string(), v.minLength(21), v.maxLength(21))),
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
  propertyId: propertyIdSchema,
});

const propertySummaryEntries = {
  matterId: matterIdSchema,
  name: v.pipe(v.string(), v.description("Property name")),
  propertyId: propertyIdSchema,
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
  entityId: entityIdSchema,
  fields: v.array(entityFieldItemSchema),
  kind: entityKindSchema,
  matterId: matterIdSchema,
  name: v.pipe(v.string(), v.description("Entity name")),
  parentId: v.nullable(
    v.pipe(v.string(), v.description("Parent folder entity ID")),
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
  entityId: entityIdSchema,
  matterId: matterIdSchema,
  name: v.nullable(v.pipe(v.string(), v.description("Entity name"))),
  sourceDocument: sourceDocumentSchema,
  text: v.pipe(v.string(), v.description("Extracted text content")),
  truncated: v.pipe(
    v.boolean(),
    v.description("Whether the text was truncated"),
  ),
});

const listMatterPropertiesInputSchema = v.strictObject({
  matterIds: matterIdsSchema,
  ...paginationInputEntries,
});

const getMatterPropertiesInputSchema = v.strictObject({
  matterIds: matterIdsSchema,
  propertyIds: propertyIdsSchema,
});

const listMatterEntitiesInputSchema = v.strictObject({
  kind: v.optional(
    v.pipe(entityKindSchema, v.description("Optional entity kind filter")),
  ),
  matterIds: matterIdsSchema,
  parentId: v.optional(
    v.pipe(
      v.string(),
      v.uuid(),
      v.description("Optional parent folder entity ID"),
    ),
  ),
  ...paginationInputEntries,
});

const getMatterEntitiesInputSchema = v.strictObject({
  entityIds: entityIdsSchema,
  matterIds: matterIdsSchema,
});

const getMatterEntityContentsInputSchema = v.strictObject({
  entityIds: contentEntityIdsSchema,
  matterIds: matterIdsSchema,
});

export const listMatterPropertiesContract = createReadonlyFunctionContract({
  description:
    "List compact property summaries for one or more matters. Supports pagination.",
  input: listMatterPropertiesInputSchema,
  name: "listMatterProperties",
  output: buildPaginatedOutputSchema(propertySummarySchema),
});

export const getMatterPropertiesContract = createReadonlyFunctionContract({
  description:
    "Get full property definitions, including property content and tool configuration, for known property IDs in known matters.",
  input: getMatterPropertiesInputSchema,
  name: "getMatterProperties",
  output: v.array(propertyDetailSchema),
});

export const listMatterEntitiesContract = createReadonlyFunctionContract({
  description:
    "List compact entity summaries for one or more matters. Each field's `content` is the stored value discriminated union (same shape as the DB). Resolve property display names via `listMatterProperties` or `getMatterProperties`. Supports optional kind and parent filters plus pagination.",
  input: listMatterEntitiesInputSchema,
  name: "listMatterEntities",
  output: buildPaginatedOutputSchema(entitySummarySchema),
});

export const getMatterEntitiesContract = createReadonlyFunctionContract({
  description:
    "Get rich entity details for known entity IDs in known matters. Each field's `content` is the stored value discriminated union (same shape as the DB). Resolve property display names via `listMatterProperties` or `getMatterProperties`.",
  input: getMatterEntitiesInputSchema,
  name: "getMatterEntities",
  output: v.array(entityDetailSchema),
});

export const getMatterEntityContentsContract = createReadonlyFunctionContract({
  description:
    "Get extracted text content for known entity IDs in known matters. Text is truncated server-side when needed.",
  input: getMatterEntityContentsInputSchema,
  name: "getMatterEntityContents",
  output: v.array(entityContentSchema),
});

export const readonlyWorkspaceFunctionContracts = [
  listMatterPropertiesContract,
  getMatterPropertiesContract,
  listMatterEntitiesContract,
  getMatterEntitiesContract,
  getMatterEntityContentsContract,
] as const;

export type ReadonlyWorkspaceFunctionName =
  (typeof readonlyWorkspaceFunctionContracts)[number]["name"];

export const buildReadonlyWorkspaceFunctionManifest = (): Result<
  ReadonlyFunctionManifest[],
  ChatToolValidationError
> => buildReadonlyFunctionManifest(readonlyWorkspaceFunctionContracts);

export const buildReadonlyWorkspaceFnTypes = () =>
  buildReadonlyFunctionTypeDeclarations(readonlyWorkspaceFunctionContracts);
