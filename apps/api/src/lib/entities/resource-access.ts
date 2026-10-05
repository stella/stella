import { and, eq, inArray, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { entities, entityVersions, fields } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";

const RESOURCE_TABLES = {
  entity: entities,
  entityVersion: entityVersions,
  field: fields,
} as const;

type ResourceAccessOptions = {
  inputs: readonly { schema: unknown; value: unknown }[];
  scopedDb: ScopedDb;
  workspaceId?: SafeId<"workspace">;
};

/** Trusted id schemas enumerate direct resource access before handler details run. */
export const resourcesAreVisible = async ({
  inputs,
  scopedDb,
  workspaceId,
}: ResourceAccessOptions): Promise<boolean> => {
  const identifiers = new Map<string, Set<string>>();
  const visit = (schema: unknown, value: unknown) => {
    if (!isRecord(schema)) {
      return;
    }
    const kind = schema["x-stella-resource-kind"];
    if (
      typeof kind === "string" &&
      Object.hasOwn(RESOURCE_TABLES, kind) &&
      typeof value === "string"
    ) {
      let ids = identifiers.get(kind);
      if (ids === undefined) {
        ids = new Set();
        identifiers.set(kind, ids);
      }
      ids.add(value);
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(schema["items"], item);
      }
    }
    if (isRecord(value) && isRecord(schema["properties"])) {
      for (const [key, nested] of Object.entries(schema["properties"])) {
        visit(nested, value[key]);
      }
    }
    for (const union of [schema["anyOf"], schema["oneOf"], schema["allOf"]]) {
      if (Array.isArray(union)) {
        for (const branch of union) {
          visit(branch, value);
        }
      }
    }
  };
  for (const { schema, value } of inputs) {
    visit(schema, value);
  }
  if (identifiers.size === 0) {
    return true;
  }
  return await scopedDb(async (tx) => {
    for (const [kind, table] of Object.entries(RESOURCE_TABLES)) {
      const ids = identifiers.get(kind);
      if (ids === undefined) {
        continue;
      }
      const rows = await tx
        .select({ id: table.id })
        .from(table)
        .where(
          and(
            inArray(
              table.id,
              [...ids].map((id) => sql`${id}`),
            ),
            workspaceId === undefined
              ? undefined
              : eq(table.workspaceId, workspaceId),
          ),
        );
      if (rows.length !== ids.size) {
        return false;
      }
    }
    return true;
  });
};
