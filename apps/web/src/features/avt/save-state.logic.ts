import { panic } from "better-result";

/**
 * Per-item save indicators, derived from the mutations TanStack Query already
 * tracks rather than a parallel store: each AVT save names the items it
 * touches in its `targetIds` variable.
 */
export type SaveState = "idle" | "saving" | "saved" | "failed";

type SaveEntry = {
  targetIds: readonly string[];
  status: "idle" | "pending" | "success" | "error";
};

/**
 * One item's save indicator from the saves sent this session, oldest first:
 * saving while any is in flight, otherwise the outcome of the latest one that
 * touched the item.
 */
export const saveStateOf = (
  entries: readonly SaveEntry[],
  targetId: string,
): SaveState => {
  const touching = entries.filter((entry) =>
    entry.targetIds.includes(targetId),
  );
  if (touching.some((entry) => entry.status === "pending")) {
    return "saving";
  }
  const latest = touching.at(-1)?.status ?? "idle";
  switch (latest) {
    case "idle": {
      return "idle";
    }
    case "pending": {
      return "saving";
    }
    case "success": {
      return "saved";
    }
    case "error": {
      return "failed";
    }
    default: {
      latest satisfies never;
      return panic(`Unhandled mutation status: ${String(latest)}`);
    }
  }
};

/** The `targetIds` of a mutation's variables, which the cache types as unknown. */
export const readTargetIds = (variables: unknown): string[] => {
  if (
    typeof variables !== "object" ||
    variables === null ||
    !("targetIds" in variables) ||
    !Array.isArray(variables.targetIds)
  ) {
    return [];
  }
  return variables.targetIds.filter(
    (id): id is string => typeof id === "string",
  );
};
