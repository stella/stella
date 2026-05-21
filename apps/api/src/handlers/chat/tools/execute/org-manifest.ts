import type { Result } from "better-result";
import * as v from "valibot";

import { ENTITY_KINDS } from "@/api/db/schema";
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

// @valibot/to-json-schema rejects regex flags, so v.regex literals
// in this file deliberately omit the `u` flag.
/* eslint-disable require-unicode-regexp */
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

const contactRefSchema = v.pipe(
  v.string(),
  v.regex(/^contact_\d+$/),
  v.description("Short contact ref returned by Stella tools"),
);
/* eslint-enable require-unicode-regexp */

const matterRefsSchema = v.pipe(
  v.array(matterRefSchema),
  v.minLength(1),
  v.maxLength(LIMITS.chatExecuteDetailIdsMax),
  v.description("Matter refs to inspect"),
);

const contactRefsSchema = v.pipe(
  v.array(contactRefSchema),
  v.minLength(1),
  v.maxLength(LIMITS.chatExecuteDetailIdsMax),
  v.description("Contact refs to inspect"),
);

const aiSearchLimitSchema = v.optional(
  v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(20),
    v.description("Max search hits to return"),
  ),
  10,
);

const matterListItemSchema = v.strictObject({
  lastActivityAt: v.pipe(
    v.string(),
    v.description("ISO timestamp of the last activity"),
  ),
  matterRef: matterRefSchema,
  mention: v.pipe(
    v.string(),
    v.description("Markdown mention to copy when referring to this matter"),
  ),
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
  matterRef: matterRefSchema,
  mention: v.pipe(
    v.string(),
    v.description("Markdown mention to copy when referring to this matter"),
  ),
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

const contactEmailSchema = v.strictObject({
  address: v.pipe(v.string(), v.description("Email address")),
  isPrimary: v.boolean(),
  label: v.optional(v.pipe(v.string(), v.description("Custom label"))),
  type: v.picklist(["work", "personal", "other"]),
});

const contactPhoneSchema = v.strictObject({
  isPrimary: v.boolean(),
  label: v.optional(v.pipe(v.string(), v.description("Custom label"))),
  number: v.pipe(v.string(), v.description("Phone number")),
  type: v.picklist(["mobile", "office", "home", "fax", "other"]),
});

const contactSummaryEntries = {
  contactRef: contactRefSchema,
  displayName: v.pipe(v.string(), v.description("Contact display name")),
  primaryEmail: v.nullable(v.pipe(v.string(), v.description("Primary email"))),
  primaryPhone: v.nullable(v.pipe(v.string(), v.description("Primary phone"))),
  type: v.picklist(["person", "organization"]),
} as const;

const contactSummarySchema = v.strictObject(contactSummaryEntries);

const contactDetailSchema = v.strictObject({
  ...contactSummaryEntries,
  emails: v.array(contactEmailSchema),
  firstName: v.nullable(v.pipe(v.string(), v.description("First name"))),
  lastName: v.nullable(v.pipe(v.string(), v.description("Last name"))),
  organizationName: v.nullable(
    v.pipe(v.string(), v.description("Organization name")),
  ),
  phones: v.array(contactPhoneSchema),
});

const documentSearchHitSchema = v.strictObject({
  entityRef: entityRefSchema,
  headline: v.nullable(v.pipe(v.string(), v.description("Search snippet"))),
  kind: entityKindSchema,
  matterName: v.pipe(v.string(), v.description("Matter name")),
  matterRef: matterRefSchema,
  mention: v.pipe(
    v.string(),
    v.description("Markdown mention to copy when referring to this document"),
  ),
  name: v.pipe(v.string(), v.description("Document title")),
  updatedAt: v.pipe(v.string(), v.description("ISO timestamp")),
});

const listMattersInputSchema = v.strictObject({
  ...paginationInputEntries,
});

const getMattersInputSchema = v.strictObject({
  matterRefs: matterRefsSchema,
});

const listContactsInputSchema = v.strictObject({
  query: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(LIMITS.searchQueryMaxLength),
      v.description("Optional contact name search"),
    ),
  ),
  ...paginationInputEntries,
});

const getContactsInputSchema = v.strictObject({
  contactRefs: contactRefsSchema,
});

const searchMatterDocumentsInputSchema = v.strictObject({
  limit: aiSearchLimitSchema,
  matterRefs: matterRefsSchema,
  query: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(LIMITS.searchQueryMaxLength),
    v.description("Search query (keywords or phrases)"),
  ),
});

export const listMattersContract = createReadonlyFunctionContract({
  summary: "List matters the user can access.",
  details: "Use getMatters for full detail.",
  input: listMattersInputSchema,
  name: "listMatters",
  output: buildPaginatedOutputSchema(matterListItemSchema),
});

export const getMattersContract = createReadonlyFunctionContract({
  summary:
    "Get full matter details for known matter refs, including client, color, and entity/property counts.",
  input: getMattersInputSchema,
  name: "getMatters",
  output: buildItemsOutputSchema(matterDetailSchema),
});

export const listContactsContract = createReadonlyFunctionContract({
  summary:
    "List compact contact summaries in the organization, optionally filtered by name.",
  details: "Use getContacts for full detail.",
  input: listContactsInputSchema,
  name: "listContacts",
  output: buildPaginatedOutputSchema(contactSummarySchema),
});

export const getContactsContract = createReadonlyFunctionContract({
  summary: "Get contact details for known contact refs.",
  input: getContactsInputSchema,
  name: "getContacts",
  output: buildItemsOutputSchema(contactDetailSchema),
});

export const searchMatterDocumentsContract = createReadonlyFunctionContract({
  summary: "Search documents in specific known matters.",
  details:
    "First call listMatters when you need matter refs; pass only the matters relevant to the user's request.",
  input: searchMatterDocumentsInputSchema,
  name: "searchMatterDocuments",
  output: buildItemsOutputSchema(documentSearchHitSchema),
});

export const readonlyOrgFunctionContracts = [
  listMattersContract,
  getMattersContract,
  listContactsContract,
  getContactsContract,
  searchMatterDocumentsContract,
] as const satisfies readonly ReadonlyFunctionContract[];

export const buildReadonlyOrgFunctionManifest = (): Result<
  ReadonlyFunctionManifest[],
  ChatToolValidationError
> => buildReadonlyFunctionManifest(readonlyOrgFunctionContracts);

export const buildReadonlyOrgFnTypes = () =>
  buildReadonlyFunctionTypeDeclarations(readonlyOrgFunctionContracts);
