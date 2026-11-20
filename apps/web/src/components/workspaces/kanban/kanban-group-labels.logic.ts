import type { EntityKind } from "@stll/api-contract";

import type { PendingTextKey } from "@/components/pending-text";

/**
 * The message each entity kind's group is called by, wherever entities are
 * grouped by kind: the board, the grouped table and its loading face.
 */
export const ENTITY_KIND_GROUP_LABEL_IDS = {
  document: "common.document",
  folder: "common.folder",
  task: "search.kinds.task",
  message: "search.kinds.message",
  link: "search.kinds.link",
} as const satisfies Record<EntityKind, PendingTextKey>;

/** The message the bucket of entities without a group value is called by. */
export const UNCATEGORIZED_GROUP_LABEL_ID =
  "common.uncategorized" satisfies PendingTextKey;
