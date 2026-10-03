import type { ResolvedSiblingName } from "@/api/lib/entities/sibling-name";
import type { insertNamedEntity } from "@/api/lib/entities/sibling-name-insert";
import type { insertEntityBatch } from "@/api/lib/entity-versions/insert-entity-batch";

type SingleName = Parameters<typeof insertNamedEntity>[1]["name"];
type BatchName = Parameters<
  typeof insertEntityBatch
>[0]["entityRows"][number]["name"];

type RequiresResolvedName<T> = string extends T
  ? false
  : ResolvedSiblingName extends T
    ? true
    : false;

export const nameInsertionContracts = {
  single: true,
  batch: true,
} satisfies {
  single: RequiresResolvedName<SingleName>;
  batch: RequiresResolvedName<BatchName>;
};
