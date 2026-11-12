import { Result } from "better-result";
import { useRouter } from "expo-router";

import { useSession } from "@/connection/session-provider";
import { referenceTarget } from "@/state/chat-references";
import type { ChatTextReference } from "@/state/chat-references";
import { readEntityDetail } from "@/state/entity-detail";
import { entityRoute } from "@/state/search";

/**
 * Opens a reference in chat text in the app's own screens: a document to
 * its pages, a matter, a decision. An item whose label does not say what it
 * is is read first, so a document still opens to its pages and a task to
 * its details; when it cannot be read, its details sheet says so. Undefined
 * for a reference that opens nothing (a person, a skill, a source).
 */
export const useOpenReference = (
  reference: ChatTextReference,
): (() => void) | undefined => {
  const router = useRouter();
  const { end, state } = useSession();
  const target = referenceTarget(reference);
  if (target === undefined) {
    return undefined;
  }
  if (target.type === "route") {
    return () => {
      router.push(target.href);
    };
  }
  return () => {
    if (state.status !== "signed-in") {
      return;
    }
    const { source } = state;
    const { entityId, matterId, name } = target;
    void (async () => {
      const detail = await readEntityDetail({
        fetch,
        source,
        workspaceId: matterId,
        entityId,
      });
      if (Result.isError(detail) && detail.error._tag === "SignedOutError") {
        end(source);
        return;
      }
      router.push(
        entityRoute({
          entityId,
          entityKind: Result.isOk(detail) ? detail.value.kind : "unknown",
          matterName: null,
          name:
            Result.isOk(detail) && detail.value.name !== null
              ? detail.value.name
              : name,
          workspaceId: matterId,
        }),
      );
    })();
  };
};
