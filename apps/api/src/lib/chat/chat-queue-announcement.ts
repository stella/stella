import { chatQueueChangedRealtimeEvent } from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import { broadcastToUser } from "@/api/lib/sse";

/**
 * Tell the member's clients that one of their chat queues changed (its
 * messages, or what holds it), so an open chat reads it again. Call it after
 * the commit that changed it: a read before that sees the old queue. The
 * event carries nothing, so one for a write that rolled back costs a re-read.
 * A turn that starts or ends announces itself (`withChatRunPings`), and
 * clients read the queues again on that too, so the queue a turn's
 * acceptance or end changed needs no announcement of its own.
 */
export const announceChatQueueChange = ({
  organizationId,
  userId,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
}): void => {
  broadcastToUser(userId, organizationId, chatQueueChangedRealtimeEvent());
};
