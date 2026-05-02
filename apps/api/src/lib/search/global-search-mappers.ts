import { escapeAndHighlight } from "@/api/lib/search/highlight";
import type { EntityGlobalSearchHit } from "@/api/lib/search/types";
import { parseEntityKind } from "@/api/lib/search/types";

type RawRow = Record<string, unknown>;

type ScoredEntityGlobalSearchHit = {
  hit: EntityGlobalSearchHit;
  score: number;
};

const toIso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

const toNullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
};

const toHeadline = (value: unknown): string | null => {
  const text = toNullableString(value);
  // `ts_headline` is configured with non-HTML markers; escape user text first,
  // then swap only those sentinel markers for <mark> tags.
  return text === null ? null : escapeAndHighlight(text);
};

export const mapEntityHit = (row: RawRow): ScoredEntityGlobalSearchHit => {
  const kind = parseEntityKind(row["type"]);
  const entityId = String(row["id"]);
  const workspaceId = String(row["workspace_id"]);
  const hit: EntityGlobalSearchHit = {
    id: `entity:${entityId}`,
    type: kind,
    entityId,
    workspaceId,
    workspaceName: String(row["workspace_name"]),
    title: String(row["title"]),
    headline: toHeadline(row["headline"]),
    updatedAt: toIso(row["updated_at"]),
    lastEditedByName: toNullableString(row["last_edited_by_name"]),
    lastEditedByImage: toNullableString(row["last_edited_by_image"]),
    mimeType: toNullableString(row["mime_type"]),
  };

  return { hit, score: Number(row["score"]) };
};
