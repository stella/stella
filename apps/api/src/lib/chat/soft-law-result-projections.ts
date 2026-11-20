import * as v from "valibot";

import { GUIDANCE_KINDS } from "@stll/legal-ast/document-kind";

import {
  SOFT_LAW_DOCUMENT_CLASS,
  SOFT_LAW_TEXT_STATE,
} from "../legal-search/soft-law-read";
import { contentText, passthroughId, publicUrl } from "./projection-fields";

const servedGuidanceFields = {
  documentId: passthroughId(),
  // Fixed value: states on every result that this is guidance, not case law.
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
  source_url: v.nullable(publicUrl()),
  attribution: v.strictObject({
    text: v.string(),
    termsUrl: v.nullable(publicUrl()),
    conditions: v.array(v.string()),
    summaryDisclaimer: v.nullable(v.string()),
  }),
} as const;

const accessField = v.picklist(["text", "metadata"]);

/** search_guidance. Source of truth: `handleSearchGuidanceTool` (`soft-law-tools.ts`). */
export const SEARCH_GUIDANCE_PROJECTION = v.strictObject({
  nextCursor: v.nullable(passthroughId()),
  results: v.array(
    v.strictObject({
      ...servedGuidanceFields,
      access: accessField,
      snippet: v.nullable(contentText()),
    }),
  ),
});

/** read_guidance. Source of truth: `handleReadGuidanceTool` (`soft-law-tools.ts`). */
export const READ_GUIDANCE_PROJECTION = v.strictObject({
  nextCursor: v.nullable(passthroughId()),
  guidance: v.strictObject({
    ...servedGuidanceFields,
    access: accessField,
    textState: v.picklist(Object.values(SOFT_LAW_TEXT_STATE)),
    text: v.nullable(contentText()),
    truncated: v.boolean(),
  }),
});
