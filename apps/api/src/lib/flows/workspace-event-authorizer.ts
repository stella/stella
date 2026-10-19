import { rootDb } from "@/api/db/root";
import { deliverFlowRunWorkspaceEvent } from "@/api/lib/flows/flow-run-events";
import type { SseConnectionAuthorizers } from "@/api/lib/sse";

/** SSE delivery resolves current recipients before a request-scoped transaction exists. */
export const authorizeFlowWorkspaceEvent = async (
  lookup: Parameters<SseConnectionAuthorizers["workspaceEvent"]>[0],
) => await deliverFlowRunWorkspaceEvent({ ...lookup, database: rootDb });
