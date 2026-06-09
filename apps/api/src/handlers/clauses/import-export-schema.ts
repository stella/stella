import { isRecord } from "@/api/lib/type-guards";

import type { ClauseMetadata } from "./metadata";
import { isClauseBody } from "./types";
import type { ClauseBody } from "./types";

export type ClauseExportVariant = {
  label: string;
  body: ClauseBody;
};

export type ClauseExportItem = {
  title: string;
  description: string | null;
  usageNotes: string | null;
  language: string | null;
  body: ClauseBody;
  // Author-curated alternative bodies. Optional so exports predating
  // variant support still import. Version history is intentionally not
  // exported: it is instance-local and the current body imports as v1.
  variants?: ClauseExportVariant[];
  metadata: ClauseMetadata | Record<string, unknown> | null;
  categoryName: string | null;
  categoryPath: string[] | null;
};

export type ClauseExportPayload = {
  version: 1;
  exportedAt: string;
  clauses: ClauseExportItem[];
};

const isClauseExportVariantShape = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value["label"] !== "string" || !value["label"]) {
    return false;
  }
  return isClauseBody(value["body"]);
};

const isClauseExportItemShape = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value["title"] !== "string" || !value["title"]) {
    return false;
  }
  if (!isClauseBody(value["body"])) {
    return false;
  }
  if (
    value["metadata"] !== undefined &&
    value["metadata"] !== null &&
    !isRecord(value["metadata"])
  ) {
    return false;
  }
  const variants = value["variants"];
  if (variants !== undefined) {
    if (!Array.isArray(variants)) {
      return false;
    }
    return variants.every(isClauseExportVariantShape);
  }
  return true;
};

export const isClauseExportPayload = (
  value: unknown,
): value is ClauseExportPayload => {
  if (!isRecord(value)) {
    return false;
  }
  if (value["version"] !== 1) {
    return false;
  }
  if (typeof value["exportedAt"] !== "string") {
    return false;
  }
  if (!Array.isArray(value["clauses"])) {
    return false;
  }
  return value["clauses"].every(isClauseExportItemShape);
};
