import { isClauseBody } from "./types";
import type { ClauseBody } from "./types";

export type ClauseExportItem = {
  title: string;
  description: string | null;
  usageNotes: string | null;
  language: string | null;
  body: ClauseBody;
  metadata: Record<string, unknown> | null;
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
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) {
    return false;
  }
  if (typeof obj.exportedAt !== "string") {
    return false;
  }
  if (!Array.isArray(obj.clauses)) {
    return false;
  }

  for (const clause of obj.clauses) {
    if (typeof clause !== "object" || clause === null) {
      return false;
    }
    const c = clause as Record<string, unknown>;
    if (typeof c.title !== "string" || !c.title) {
      return false;
    }
    if (!isClauseBody(c.body)) {
      return false;
    }
  }

  return true;
};
