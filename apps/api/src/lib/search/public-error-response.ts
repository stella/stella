import type { Static } from "@sinclair/typebox";
import { t } from "elysia";

import { LEGISLATION_WINDOW_DISPOSITION_BASIS_VALUES } from "@stll/api-contract/legislation-expression";

import { LIMITS } from "@/api/lib/limits";
import {
  boundedString,
  truncateTextBytes,
  nullableBoundedString,
} from "@/api/lib/search/response-text-bounds";

/** Display caps for unauthenticated errors, independent of authenticated details. */
export const PUBLIC_ERROR_TEXT_BYTES = {
  message: 2048,
  code: 128,
  hint: 2048,
  contactUrl: 2048,
  country: 3,
  status: 32,
  reason: 128,
  issuePath: 256,
  issueMessage: 1024,
  issueCount: 16,
  statusText: 128,
  versionDate: 32,
  versionCount: 8,
} as const;

export const publicInconsistentVersionsSchema = t.Array(
  t.Object(
    {
      id: boundedString(LIMITS.legislationSearchTextBytes.documentId),
      language: boundedString(LIMITS.legislationSearchTextBytes.language),
      versionValidFrom: nullableBoundedString(
        PUBLIC_ERROR_TEXT_BYTES.versionDate,
      ),
      versionValidTo: nullableBoundedString(
        PUBLIC_ERROR_TEXT_BYTES.versionDate,
      ),
      basis: t.Union([
        t.UnionEnum(LEGISLATION_WINDOW_DISPOSITION_BASIS_VALUES),
        t.Null(),
      ]),
    },
    { additionalProperties: false },
  ),
  { maxItems: PUBLIC_ERROR_TEXT_BYTES.versionCount },
);

export const safePublicHandlerErrorResponseSchema = t.Object(
  {
    message: boundedString(PUBLIC_ERROR_TEXT_BYTES.message),
    code: t.Optional(boundedString(PUBLIC_ERROR_TEXT_BYTES.code)),
    hint: t.Optional(boundedString(PUBLIC_ERROR_TEXT_BYTES.hint)),
    contactUrl: t.Optional(boundedString(PUBLIC_ERROR_TEXT_BYTES.contactUrl)),
    retryable: t.Optional(t.Boolean()),
    type: t.Optional(t.Literal("conflict")),
    versions: t.Optional(publicInconsistentVersionsSchema),
    country: t.Optional(boundedString(PUBLIC_ERROR_TEXT_BYTES.country)),
    status: t.Optional(boundedString(PUBLIC_ERROR_TEXT_BYTES.status)),
    reason: t.Optional(boundedString(PUBLIC_ERROR_TEXT_BYTES.reason)),
    issues: t.Optional(
      t.Array(
        t.Object(
          {
            path: boundedString(PUBLIC_ERROR_TEXT_BYTES.issuePath),
            message: boundedString(PUBLIC_ERROR_TEXT_BYTES.issueMessage),
          },
          { additionalProperties: false },
        ),
        { maxItems: PUBLIC_ERROR_TEXT_BYTES.issueCount },
      ),
    ),
  },
  { additionalProperties: false },
);

export const safePublicHandlerErrorOrStatusTextResponseSchema = t.Union([
  safePublicHandlerErrorResponseSchema,
  boundedString(PUBLIC_ERROR_TEXT_BYTES.statusText),
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalText = (value: unknown, maxBytes: number) =>
  typeof value === "string" ? truncateTextBytes(value, maxBytes) : undefined;

/** Public errors expose corrective fields, never authenticated ceremony details. */
export const projectPublicErrorBody = (
  value: unknown,
): Static<typeof safePublicHandlerErrorResponseSchema> => {
  if (!isObject(value)) {
    return { message: "Internal server error" };
  }
  const issues = Array.isArray(value["issues"])
    ? value["issues"]
        .slice(0, PUBLIC_ERROR_TEXT_BYTES.issueCount)
        .filter(isObject)
        .map((issue) => ({
          path:
            optionalText(issue["path"], PUBLIC_ERROR_TEXT_BYTES.issuePath) ??
            "",
          message:
            optionalText(
              issue["message"],
              PUBLIC_ERROR_TEXT_BYTES.issueMessage,
            ) ?? "Internal server error",
        }))
    : undefined;
  const versions = Array.isArray(value["versions"])
    ? value["versions"]
        .slice(0, PUBLIC_ERROR_TEXT_BYTES.versionCount)
        .filter(isObject)
        .map((version) => ({
          id:
            optionalText(
              version["id"],
              LIMITS.legislationSearchTextBytes.documentId,
            ) ?? "",
          language:
            optionalText(
              version["language"],
              LIMITS.legislationSearchTextBytes.language,
            ) ?? "",
          versionValidFrom:
            optionalText(
              version["versionValidFrom"],
              PUBLIC_ERROR_TEXT_BYTES.versionDate,
            ) ?? null,
          versionValidTo:
            optionalText(
              version["versionValidTo"],
              PUBLIC_ERROR_TEXT_BYTES.versionDate,
            ) ?? null,
          basis:
            LEGISLATION_WINDOW_DISPOSITION_BASIS_VALUES.find(
              (basis) => basis === version["basis"],
            ) ?? null,
        }))
    : undefined;
  const code = optionalText(value["code"], PUBLIC_ERROR_TEXT_BYTES.code);
  const hint = optionalText(value["hint"], PUBLIC_ERROR_TEXT_BYTES.hint);
  const contactUrl = optionalText(
    value["contactUrl"],
    PUBLIC_ERROR_TEXT_BYTES.contactUrl,
  );
  const country = optionalText(
    value["country"],
    PUBLIC_ERROR_TEXT_BYTES.country,
  );
  const status = optionalText(value["status"], PUBLIC_ERROR_TEXT_BYTES.status);
  const reason = optionalText(value["reason"], PUBLIC_ERROR_TEXT_BYTES.reason);
  return {
    message:
      optionalText(value["message"], PUBLIC_ERROR_TEXT_BYTES.message) ??
      "Internal server error",
    ...(value["type"] === "conflict" ? { type: value["type"] } : {}),
    ...(versions === undefined ? {} : { versions }),
    ...(code === undefined ? {} : { code }),
    ...(hint === undefined ? {} : { hint }),
    ...(contactUrl === undefined ? {} : { contactUrl }),
    ...(country === undefined ? {} : { country }),
    ...(status === undefined ? {} : { status }),
    ...(reason === undefined ? {} : { reason }),
    ...(typeof value["retryable"] === "boolean"
      ? { retryable: value["retryable"] }
      : {}),
    ...(issues === undefined ? {} : { issues }),
  };
};

// JSON escapes each ASCII control byte to six bytes; field names and punctuation
// fit in the fixed allowance. This bounds the actual wire form, not just text.
export const PUBLIC_ERROR_RESPONSE_MAX_BYTES =
  1024 +
  6 *
    PUBLIC_ERROR_TEXT_BYTES.versionCount *
    (LIMITS.legislationSearchTextBytes.documentId +
      LIMITS.legislationSearchTextBytes.language +
      2 * PUBLIC_ERROR_TEXT_BYTES.versionDate +
      128) +
  6 *
    (PUBLIC_ERROR_TEXT_BYTES.message +
      PUBLIC_ERROR_TEXT_BYTES.code +
      PUBLIC_ERROR_TEXT_BYTES.hint +
      PUBLIC_ERROR_TEXT_BYTES.contactUrl +
      PUBLIC_ERROR_TEXT_BYTES.country +
      PUBLIC_ERROR_TEXT_BYTES.status +
      PUBLIC_ERROR_TEXT_BYTES.reason +
      PUBLIC_ERROR_TEXT_BYTES.issueCount *
        (PUBLIC_ERROR_TEXT_BYTES.issuePath +
          PUBLIC_ERROR_TEXT_BYTES.issueMessage +
          32));
