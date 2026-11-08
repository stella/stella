import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";
import { GUIDANCE_KINDS } from "@stll/legal-ast/document-kind";

import { safePublicHandlerResponseSchemasWithStatusText } from "@/api/lib/api-handlers";
import { paginationCursorSchema } from "@/api/lib/custom-schema";
import {
  SOFT_LAW_DOCUMENT_CLASS,
  SOFT_LAW_SEARCH_PAGE_SIZE_MAX,
  SOFT_LAW_TEXT_STATE,
} from "@/api/lib/legal-search/soft-law-read";
import { LIMITS } from "@/api/lib/limits";

const attributionSchema = v.strictObject({
  text: v.string(),
  termsUrl: v.nullable(v.string()),
  conditions: v.array(v.string()),
  summaryDisclaimer: v.nullable(v.string()),
});

const servedDocumentEntries = {
  documentId: v.string(),
  documentClass: v.literal(SOFT_LAW_DOCUMENT_CLASS),
  notice: v.string(),
  issuer: v.strictObject({
    authority: v.string(),
    name: v.string(),
    jurisdiction: v.string(),
  }),
  kind: v.picklist(GUIDANCE_KINDS),
  sourceKind: v.nullable(v.string()),
  title: v.string(),
  reference: v.nullable(v.string()),
  issuedOn: v.nullable(v.string()),
  validity: v.strictObject({ state: v.string(), basis: v.string() }),
  language: v.nullable(v.string()),
  publisherUrl: v.nullable(v.string()),
  attribution: attributionSchema,
};

const accessSchema = v.picklist(["text", "metadata"]);

export const searchSoftLawBodySchema = v.strictObject({
  query: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(LIMITS.searchQueryMaxLength),
  ),
  authority: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
  jurisdiction: v.optional(v.pipe(v.string(), v.minLength(2), v.maxLength(3))),
  kind: v.optional(v.picklist(GUIDANCE_KINDS)),
  dateFrom: v.optional(apiDateSchema),
  dateTo: v.optional(apiDateSchema),
  limit: v.optional(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(SOFT_LAW_SEARCH_PAGE_SIZE_MAX),
    ),
  ),
  cursor: v.optional(paginationCursorSchema()),
});

export const searchSoftLawResponseSchema =
  safePublicHandlerResponseSchemasWithStatusText(
    v.strictObject({
      items: v.array(
        v.strictObject({
          ...servedDocumentEntries,
          access: accessSchema,
          snippet: v.nullable(v.string()),
        }),
      ),
      nextCursor: v.nullable(v.string()),
    }),
  );

export const readSoftLawResponseSchema =
  safePublicHandlerResponseSchemasWithStatusText(
    v.strictObject({
      ...servedDocumentEntries,
      access: accessSchema,
      textState: v.picklist(Object.values(SOFT_LAW_TEXT_STATE)),
      text: v.nullable(v.string()),
    }),
  );
