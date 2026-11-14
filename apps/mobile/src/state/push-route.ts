import type { Href } from "expo-router";
import * as v from "valibot";

/**
 * What a notification carries for the app to open: opaque ids only, never a
 * matter's or a document's name, since the alert passes through Apple.
 */
const pushDataSchema = v.object({
  kind: v.string(),
  workspaceId: v.nullish(v.string()),
  entityType: v.nullish(v.string()),
  entityId: v.nullish(v.string()),
});

/**
 * Where a tapped notification leads: the chat it points at, or the item it
 * points at in its matter, else the matter, else the app's first tab. Data the app cannot read opens
 * the app and nothing more.
 */
export const routeForPush = (data: unknown): Href => {
  // The server puts its part beside `aps`, under `stella`.
  const parsed = v.safeParse(v.object({ stella: pushDataSchema }), data);
  if (!parsed.success) {
    return "/";
  }
  const { entityId, entityType, workspaceId } = parsed.output.stella;
  // A chat opens by its id, inside or outside a matter.
  if (
    entityType === "chat_thread" &&
    entityId !== null &&
    entityId !== undefined
  ) {
    // A matter's chat reads only within its matter.
    return {
      pathname: "/thread/[threadId]",
      params:
        workspaceId === null || workspaceId === undefined
          ? { threadId: entityId }
          : { matterId: workspaceId, threadId: entityId },
    };
  }
  if (workspaceId === null || workspaceId === undefined) {
    return "/";
  }
  if (entityType === "entity" && entityId !== null && entityId !== undefined) {
    return {
      pathname: "/matter/[workspaceId]/[entityId]",
      params: { entityId, workspaceId },
    };
  }
  return { pathname: "/matter/[workspaceId]", params: { workspaceId } };
};
