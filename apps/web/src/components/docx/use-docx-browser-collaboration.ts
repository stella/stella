import { useCallback, useState } from "react";
import type { RefObject } from "react";

import { panic } from "better-result";

import type { DocxEditorCollaboration } from "@stll/folio-react";

import { env } from "@/env";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { getDisplayName } from "@/lib/get-display-name";

import { useCollaborationVersionPublisher } from "./use-collaboration-version-publisher";
import { useFolioCollaborationRoom } from "./use-folio-collaboration-room";

type UseDocxBrowserCollaborationOptions = {
  canUnlock: boolean;
  entityId: string;
  externalCollaboration?: DocxEditorCollaboration | undefined;
  /** Cleared once a published version captures the session's changes. */
  hasSessionChangesRef: RefObject<boolean>;
  initiallyRequested: boolean;
  onPublishableChange: ((publishable: boolean) => void) | undefined;
  propertyId: string;
  workspaceId: string;
};

type CollaborationRequestState =
  | { status: "automatic" }
  | { status: "cancelled"; targetKey: string }
  | { status: "requested"; targetKey: string };

export type DocxBrowserCollaboration = ReturnType<
  typeof useDocxBrowserCollaboration
>;

/**
 * The collaboration room this editor joins: whether it is requested, the
 * room's state, and publishing the room as a document version.
 */
export const useDocxBrowserCollaboration = ({
  canUnlock,
  entityId,
  externalCollaboration,
  hasSessionChangesRef,
  initiallyRequested,
  onPublishableChange,
  propertyId,
  workspaceId,
}: UseDocxBrowserCollaborationOptions) => {
  const targetKey = `${workspaceId}:${entityId}:${propertyId}`;
  const [requestState, setRequestState] = useState(
    (): CollaborationRequestState => ({ status: "automatic" }),
  );
  const requested = (() => {
    if (
      requestState.status === "automatic" ||
      requestState.targetKey !== targetKey
    ) {
      return initiallyRequested;
    }

    switch (requestState.status) {
      case "requested":
        return true;
      case "cancelled":
        return false;
      default: {
        requestState satisfies never;
        return panic(`Unhandled request state: ${String(requestState)}`);
      }
    }
  })();
  // Read the identity from the provider, not from route context. The editor
  // is persistent chrome: the inspector keeps it mounted across navigation,
  // so a strict `useRouteContext({ from: "/_protected" })` throws the moment
  // the user opens a route outside that tree (`/law/*` is top level).
  // `AuthenticatedUserProvider` wraps both trees, and the maybe- variant keeps
  // the editor renderable on public law routes that have no user at all.
  const currentUser = useMaybeAuthenticatedUser();
  const collaborationEnabled =
    env.VITE_FEATURE_FOLIO_COLLAB && env.VITE_COLLAB_URL !== undefined;
  const collaborationState = useFolioCollaborationRoom({
    enabled: collaborationEnabled && requested && canUnlock,
    entityId,
    propertyId,
    user: currentUser
      ? {
          id: currentUser.id,
          image: currentUser.image ?? null,
          name:
            getDisplayName(currentUser.name, currentUser.email) ??
            currentUser.email,
        }
      : null,
    workspaceId,
  });
  const collaborationSession = collaborationState.room;
  const cancelCollaboration = useCallback(() => {
    setRequestState((previous) =>
      previous.status === "cancelled" && previous.targetKey === targetKey
        ? previous
        : { status: "cancelled", targetKey },
    );
  }, [targetKey]);
  const requestCollaboration = useCallback(() => {
    setRequestState((previous) =>
      previous.status === "requested" && previous.targetKey === targetKey
        ? previous
        : { status: "requested", targetKey },
    );
  }, [targetKey]);
  const {
    canPublishCollaborationVersion,
    discardPendingPublication,
    publishCollaborationVersion,
  } = useCollaborationVersionPublisher({
    collaborationSession,
    collaborationStatus: collaborationState.status,
    hasSessionChangesRef,
    workspaceId,
  });

  useExternalSyncEffect(() => {
    onPublishableChange?.(canPublishCollaborationVersion);
    return () => onPublishableChange?.(false);
  }, [canPublishCollaborationVersion, onPublishableChange]);

  return {
    activeCollaboration:
      collaborationSession?.collaboration ?? externalCollaboration,
    cancelCollaboration,
    canPublishCollaborationVersion,
    collaborationEnabled,
    collaborationSession,
    collaborationState,
    canEditCollaboratively:
      collaborationSession !== null && collaborationState.status !== "readOnly",
    discardPendingPublication,
    isCollaborativeEditing: collaborationSession !== null,
    publishCollaborationVersion,
    requestCollaboration,
  };
};
