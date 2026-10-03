import type { ResolvedSiblingName } from "@/api/lib/entities/sibling-name";
import type {
  insertNamedEntity,
  ResolvedSiblingNames,
} from "@/api/lib/entities/sibling-name-insert";
import type { insertEntityBatch } from "@/api/lib/entity-versions/insert-entity-batch";
import type { SanitizedFileName } from "@/api/lib/sanitize-filename";

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

export const siblingNameKinds = {
  displayIsFileName: false,
  fileIsDisplayName: false,
  resolvedFileName: true,
} satisfies {
  displayIsFileName: ResolvedSiblingName extends SanitizedFileName
    ? true
    : false;
  fileIsDisplayName: SanitizedFileName extends ResolvedSiblingName
    ? true
    : false;
  resolvedFileName: ResolvedSiblingNames["fileName"] extends SanitizedFileName
    ? true
    : false;
};
