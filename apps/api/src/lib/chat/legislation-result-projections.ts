import * as v from "valibot";

import {
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_WINDOW_DISPOSITION_BASES,
  LEGISLATION_WINDOW_DISPOSITIONS,
} from "@stll/api-contract/legislation-expression";

import {
  PROVISION_ABSENCE_STATUSES,
  PROVISION_STATUS,
} from "../legal-search/legislation-provision-vocabulary";
import {
  passthroughId,
  projectionBranch,
  publicUrl,
} from "./projection-fields";

/**
 * What a version's dates mean: its kind, and whether its window is one the
 * text applied in. A window labelled anything but `effective` never applied,
 * however its dates read.
 */
export const statuteExpressionLabel = {
  expressionKind: v.picklist(LEGISLATION_EXPRESSION_KINDS),
  windowDisposition: v.picklist(LEGISLATION_WINDOW_DISPOSITIONS),
  windowDispositionBasis: v.nullable(
    v.picklist(Object.values(LEGISLATION_WINDOW_DISPOSITION_BASES).flat()),
  ),
} as const;

const provisionEntrySubject = {
  // The publisher's anchor, echoed so a batch reply says which entry it is.
  anchor: passthroughId(),
  eli: v.string(),
} as const;

// The provision's printed citation beside its reader link, absent where its
// jurisdiction has no citation profile.
const provisionCitation = { citation: v.optional(v.string()) } as const;

/**
 * read_statute_provisions. Source of truth:
 * `handleReadStatuteProvisionsTool` (`legislation-tools.ts`). One entry per
 * requested item, in input order: a batch read reports per entry rather than
 * failing whole, so the union is discriminated on `status` and every absence
 * carries its own message.
 */
export const READ_STATUTE_PROVISIONS_PROJECTION = v.strictObject({
  items: v.array(
    v.variant("status", [
      projectionBranch(
        v.strictObject({
          ...provisionEntrySubject,
          url: v.nullable(publicUrl()),
          source_url: v.optional(publicUrl()),
          ...provisionCitation,
          documentId: passthroughId(),
          resourceName: passthroughId(),
          status: v.literal(PROVISION_STATUS.found),
          text: v.string(),
          nextTextCursor: v.nullable(passthroughId()),
          truncated: v.boolean(),
          versionValidFrom: v.nullable(v.string()),
          versionValidTo: v.nullable(v.string()),
        }),
      ),
      ...PROVISION_ABSENCE_STATUSES.map((status) =>
        projectionBranch(
          v.strictObject({
            ...provisionEntrySubject,
            url: v.optional(v.nullable(publicUrl())),
            source_url: v.optional(publicUrl()),
            ...provisionCitation,
            message: v.string(),
            status: v.literal(status),
          }),
        ),
      ),
      // An entry the input schema refused. It carries its position and its
      // issues rather than the subject fields, because the subject is what
      // failed to parse; the entries beside it are still answered.
      projectionBranch(
        v.strictObject({
          index: v.number(),
          issues: v.array(
            v.strictObject({ message: v.string(), path: v.string() }),
          ),
          message: v.string(),
          status: v.literal(PROVISION_STATUS.invalid),
        }),
      ),
    ]),
  ),
});

const statuteProvisionVersion = {
  url: v.nullable(publicUrl()),
  source_url: v.optional(publicUrl()),
  ...provisionCitation,
  documentId: passthroughId(),
  resourceName: passthroughId(),
  versionValidFrom: v.nullable(v.string()),
  versionValidTo: v.nullable(v.string()),
  ...statuteExpressionLabel,
} as const;

/**
 * read_provision_history. Source of truth: `handleReadProvisionHistoryTool`
 * (`legislation-tools.ts`) over `readProvisionHistoryHandler`. A version in
 * which the anchor is absent is dropped by that handler, so every item here
 * has an occurrence; whether its wording travels is a separate publisher
 * permission, so the items are discriminated on the same `status` vocabulary
 * the batch provision read answers in.
 */
export const READ_PROVISION_HISTORY_PROJECTION = v.strictObject({
  ...provisionEntrySubject,
  items: v.array(
    v.variant("status", [
      projectionBranch(
        v.strictObject({
          ...statuteProvisionVersion,
          status: v.literal(PROVISION_STATUS.found),
          text: v.string(),
          nextTextCursor: v.nullable(passthroughId()),
          truncated: v.boolean(),
        }),
      ),
      projectionBranch(
        v.strictObject({
          ...statuteProvisionVersion,
          message: v.string(),
          status: v.literal(PROVISION_STATUS.textWithheld),
        }),
      ),
    ]),
  ),
  // Opaque `[versionValidFrom, documentId]` cursor, base64url-encoded.
  nextCursor: v.nullable(passthroughId()),
});
