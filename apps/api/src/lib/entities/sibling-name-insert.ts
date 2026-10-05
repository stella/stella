import { and, eq, isNull, type SQL } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entities } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  resolveSiblingName,
  type ResolvedSiblingName,
} from "@/api/lib/entities/sibling-name";
import {
  sanitizeFilename,
  type SanitizedFileName,
} from "@/api/lib/sanitize-filename";

export type ResolvedSiblingNames = {
  name: ResolvedSiblingName;
  fileName: SanitizedFileName;
};

const resolveSiblingNames = (
  options: Parameters<typeof resolveSiblingName>[0],
): ResolvedSiblingNames => {
  const name = resolveSiblingName(options);
  return { name, fileName: sanitizeFilename(name) };
};

type SiblingScope = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  parentId: SafeId<"entity"> | null;
};

type ReadSiblingNamesOptions = Omit<SiblingScope, "parentId"> & {
  scope:
    | { type: "parent"; parentId: SafeId<"entity"> | null }
    | { type: "matter" };
};

/** The workspace cap bounds this complete internal sibling set. */
const readSiblingNames = async ({
  tx,
  workspaceId,
  scope,
}: ReadSiblingNamesOptions) => {
  let parentCondition: SQL | undefined;
  if (scope.type === "parent") {
    parentCondition =
      scope.parentId === null
        ? isNull(entities.parentId)
        : eq(entities.parentId, scope.parentId);
  }
  return await tx
    .select({ name: entities.name, parentId: entities.parentId })
    .from(entities)
    .where(and(eq(entities.workspaceId, workspaceId), parentCondition));
};

type ResolveSiblingNameForInsertOptions = SiblingScope & {
  name: string;
  kind: typeof entities.$inferSelect.kind;
};

/** Call after the creation flow's workspace lock and before publishing rows. */
export const resolveSiblingNameForInsert = async ({
  name,
  kind,
  tx,
  workspaceId,
  parentId,
}: ResolveSiblingNameForInsertOptions): Promise<ResolvedSiblingNames> => {
  const siblings = await readSiblingNames({
    tx,
    workspaceId,
    scope: { type: "parent", parentId },
  });
  return resolveSiblingNames({
    name,
    kind,
    siblingNames: new Set(siblings.map(({ name: sibling }) => sibling)),
  });
};

export type NamedEntityInsert = Omit<typeof entities.$inferInsert, "name"> & {
  name: ResolvedSiblingName;
};

export const insertNamedEntity = async (
  tx: Transaction,
  values: NamedEntityInsert,
) => await tx.insert(entities).values(values);

/** Read once, then reserve persisted and pending names without per-folder I/O. */
export const createSiblingNamePlan = async ({
  tx,
  workspaceId,
}: Omit<SiblingScope, "parentId">) => {
  const namesByParent = new Map<SafeId<"entity"> | null, Set<string>>();
  const siblings = await readSiblingNames({
    tx,
    workspaceId,
    scope: { type: "matter" },
  });
  for (const { parentId, name } of siblings) {
    const names = namesByParent.get(parentId) ?? new Set<string>();
    names.add(name);
    namesByParent.set(parentId, names);
  }
  return ({
    parentId,
    name,
    kind,
  }: Omit<ResolveSiblingNameForInsertOptions, "tx" | "workspaceId">) => {
    let siblingNames = namesByParent.get(parentId);
    if (siblingNames === undefined) {
      siblingNames = new Set();
      namesByParent.set(parentId, siblingNames);
    }
    const resolvedName = resolveSiblingNames({ name, kind, siblingNames });
    siblingNames.add(resolvedName.name);
    return resolvedName;
  };
};
