import type { Result } from "better-result";
import * as v from "valibot";

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

const matterIdSchema = v.pipe(v.string(), v.description("Matter ID"));

const matterIdsSchema = v.pipe(
  v.array(matterIdSchema),
  v.minLength(1),
  v.maxLength(LIMITS.chatExecuteDetailIdsMax),
  v.description("Matter IDs to inspect"),
);

const matterListItemSchema = v.strictObject({
  lastActivityAt: v.pipe(
    v.string(),
    v.description("ISO timestamp of the last activity"),
  ),
  matterId: matterIdSchema,
  name: v.pipe(v.string(), v.description("Matter name")),
  reference: v.nullable(v.pipe(v.string(), v.description("Matter reference"))),
});

const matterDetailSchema = v.strictObject({
  clientName: v.nullable(
    v.pipe(v.string(), v.description("Client display name")),
  ),
  color: v.nullable(v.pipe(v.string(), v.description("Matter color token"))),
  createdAt: v.pipe(v.string(), v.description("ISO timestamp")),
  entityCount: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.description("Number of entities in the matter"),
  ),
  lastActivityAt: v.pipe(
    v.string(),
    v.description("ISO timestamp of the last activity"),
  ),
  matterId: matterIdSchema,
  name: v.pipe(v.string(), v.description("Matter name")),
  propertyCount: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.description(
      "Number of metadata properties (columns) defined on the matter",
    ),
  ),
  reference: v.nullable(v.pipe(v.string(), v.description("Matter reference"))),
});

const listMattersInputSchema = v.strictObject({
  ...paginationInputEntries,
});

const getMattersInputSchema = v.strictObject({
  matterIds: matterIdsSchema,
});

export const listMattersContract = createReadonlyFunctionContract({
  description:
    "List matters the user can access. Returns lightweight top-level metadata per matter (no client or counts); use getMatters for full detail.",
  input: listMattersInputSchema,
  name: "listMatters",
  output: buildPaginatedOutputSchema(matterListItemSchema),
});

export const getMattersContract = createReadonlyFunctionContract({
  description:
    "Get full matter details for known matter IDs, including client, color, and entity/property counts.",
  input: getMattersInputSchema,
  name: "getMatters",
  output: v.array(matterDetailSchema),
});

export const readonlyOrgFunctionContracts = [
  listMattersContract,
  getMattersContract,
] as const;

export const buildReadonlyOrgFunctionManifest = (): Result<
  ReadonlyFunctionManifest[],
  ChatToolValidationError
> => buildReadonlyFunctionManifest(readonlyOrgFunctionContracts);

export const buildReadonlyOrgFnTypes = () =>
  buildReadonlyFunctionTypeDeclarations(readonlyOrgFunctionContracts);
