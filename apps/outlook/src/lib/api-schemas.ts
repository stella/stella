// The parts of stella API responses the add-in reads. Each schema names only
// the fields used here, so an added response field never breaks the pane.
//
//   GET  /v1/workspaces                               apps/api/src/handlers/workspaces/list.ts
//   GET  /v1/properties/:workspaceId                  apps/api/src/handlers/properties/list.ts
//   POST /v1/uploads/:workspaceId/presign             apps/api/src/handlers/uploads/create.ts
//   POST /v1/uploads/:workspaceId/:uploadId/finalize  apps/api/src/handlers/uploads/update.ts
//   GET  /v1/entities/:workspaceId/entity/:entityId   apps/api/src/handlers/entities/get.ts

import * as v from "valibot";

const nullableString = v.nullable(v.string());

const workspacesResponseSchema = v.object({
  workspaces: v.array(
    v.object({
      client: v.nullable(v.object({ displayName: v.string() })),
      id: v.string(),
      lastActivityAt: nullableString,
      name: v.string(),
      reference: nullableString,
    }),
  ),
});

const propertiesResponseSchema = v.array(
  v.object({
    content: v.object({ type: v.string() }),
    id: v.string(),
  }),
);

const presignResponseSchema = v.object({
  expiresAt: v.string(),
  headers: v.record(v.string(), v.string()),
  uploadId: v.string(),
  url: v.pipe(v.string(), v.url()),
});

const finalizeResponseSchema = v.object({
  finalizedResult: v.object({
    entityId: v.string(),
    fileId: v.string(),
    fileName: v.string(),
    renamed: v.boolean(),
    type: v.literal("entity_create"),
  }),
});

const entityResponseSchema = v.object({
  entityId: v.string(),
  fields: v.array(
    v.object({
      id: v.string(),
      propertyId: v.string(),
    }),
  ),
});

export const parseWorkspacesResponse = (input: unknown) =>
  v.safeParse(workspacesResponseSchema, input);

export const parsePropertiesResponse = (input: unknown) =>
  v.safeParse(propertiesResponseSchema, input);

export const parsePresignResponse = (input: unknown) =>
  v.safeParse(presignResponseSchema, input);

export const parseFinalizeResponse = (input: unknown) =>
  v.safeParse(finalizeResponseSchema, input);

export const parseEntityResponse = (input: unknown) =>
  v.safeParse(entityResponseSchema, input);
