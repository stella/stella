import { isRecord } from "@/api/lib/type-guards";

import type { ClauseMetadata } from "./metadata";
import { isClauseBody } from "./types";
import type { ClauseBody } from "./types";

export type ClauseExportItem = {
  title: string;
  description: string | null;
  usageNotes: string | null;
  language: string | null;
  body: ClauseBody;
  metadata: ClauseMetadata | Record<string, unknown> | null;
  categoryName: string | null;
  categoryPath: string[] | null;
};

export type ClauseExportPayload = {
  version: 1;
  exportedAt: string;
  clauses: ClauseExportItem[];
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

  for (const clause of value["clauses"]) {
    if (!isRecord(clause)) {
      return false;
    }
    if (typeof clause["title"] !== "string" || !clause["title"]) {
      return false;
    }
    if (!isClauseBody(clause["body"])) {
      return false;
    }
    if (
      clause["metadata"] !== undefined &&
      clause["metadata"] !== null &&
      !isRecord(clause["metadata"])
    ) {
      return false;
    }
  }

  return true;
};
