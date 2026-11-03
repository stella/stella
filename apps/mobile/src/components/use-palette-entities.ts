import { useEffect, useState } from "react";

import { Result } from "better-result";

import { useSession } from "@/connection/session-provider";
import { listChatThreads } from "@/state/chat-threads";
import type { ChatThreadSummary } from "@/state/chat-threads";
import { listMatters } from "@/state/matters";
import type { MatterSummary } from "@/state/matters";

export type PaletteEntities = {
  readonly matters: readonly MatterSummary[];
  readonly chats: readonly ChatThreadSummary[];
};

const NONE: PaletteEntities = { chats: [], matters: [] };

/**
 * The person's matters and most recent chats, for the palette to search as
 * it is typed in. Empty until they arrive; a list that fails to load stays
 * empty, and the palette's commands still work.
 */
export const usePaletteEntities = (): PaletteEntities => {
  const { state } = useSession();
  const [entities, setEntities] = useState(NONE);
  const source = state.status === "signed-in" ? state.source : null;
  useEffect(() => {
    if (source === null) {
      return undefined;
    }
    let current = true;
    void Promise.all([
      listMatters({ fetch, source }),
      listChatThreads({ fetch, source }),
    ]).then(([matters, chats]) => {
      if (current) {
        setEntities({
          chats: Result.isOk(chats) ? chats.value.threads : [],
          matters: Result.isOk(matters) ? matters.value : [],
        });
      }
      return undefined;
    });
    return () => {
      current = false;
    };
  }, [source]);
  return entities;
};
