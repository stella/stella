import { useState } from "react";

import type { HocuspocusProvider } from "@hocuspocus/provider";
import type * as HocuspocusProviderModule from "@hocuspocus/provider";
import { panic } from "better-result";
import { useTranslations } from "use-intl";
import type * as YProseMirror from "y-prosemirror";
import type * as Yjs from "yjs";

import { FetchBoundaryError } from "@stll/errors";
import type { DocxEditorCollaboration } from "@stll/folio-react";

import { env } from "@/env";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { userErrorFromThrown, userErrorMessage } from "@/lib/errors/user-safe";
import { fetchWithTimeout } from "@/lib/fetch";
import { toSafeId } from "@/lib/safe-id";

export type FolioCollaborationSession = {
  collaboration: DocxEditorCollaboration;
  roomId: string;
  seedDocumentBuffer: ArrayBuffer | null;
};

type FolioCollaborationSessionState =
  | { status: "idle"; collaboration: null }
  | { status: "opening"; collaboration: null }
  | {
      status: "ready";
      collaboration: DocxEditorCollaboration;
      provider: HocuspocusProvider;
      session: FolioCollaborationSession;
      roomId: string;
    }
  | { status: "error"; collaboration: null; message: string };

type UseFolioCollaborationSessionOptions = {
  enabled: boolean;
  entityId: string;
  propertyId: string;
  /**
   * Collaborator identity for awareness. Null when no authenticated user is
   * in scope (the editor is persistent chrome and also mounts on public law
   * routes), which disables the session: a collaboration cannot be opened
   * without an identity to publish.
   */
  user: {
    color: string;
    name: string;
  } | null;
  workspaceId: string;
};

const FOLIO_COLLAB_TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const SEED_DOCUMENT_DOWNLOAD_TIMEOUT_MS = 10_000;

type CollaborationRuntimeModules = {
  hocuspocus: typeof HocuspocusProviderModule;
  yProseMirror: typeof YProseMirror;
  yjs: typeof Yjs;
};

let collaborationRuntimeModulesPromise: Promise<CollaborationRuntimeModules> | null =
  null;

const loadCollaborationRuntimeModules =
  async (): Promise<CollaborationRuntimeModules> => {
    collaborationRuntimeModulesPromise ??= Promise.all([
      import("@hocuspocus/provider"),
      import("y-prosemirror"),
      import("yjs"),
    ])
      .then(([hocuspocus, yProseMirror, yjs]) => ({
        hocuspocus,
        yProseMirror,
        yjs,
      }))
      .catch((error: unknown) => {
        collaborationRuntimeModulesPromise = null;
        throw error;
      });

    return await collaborationRuntimeModulesPromise;
  };

const fetchSeedDocumentBuffer = async (seedDownloadUrl: string) => {
  const response = await fetchWithTimeout(seedDownloadUrl, {
    timeoutMs: SEED_DOCUMENT_DOWNLOAD_TIMEOUT_MS,
  });

  if (!response.ok) {
    throw new FetchBoundaryError({
      url: seedDownloadUrl,
      status: response.status,
      statusText: response.statusText,
      message: "Failed to download collaborative editing seed file.",
    });
  }

  return await response.arrayBuffer();
};

export const useFolioCollaborationSession = ({
  enabled,
  entityId,
  propertyId,
  user,
  workspaceId,
}: UseFolioCollaborationSessionOptions): FolioCollaborationSessionState => {
  const t = useTranslations();
  const [state, setState] = useState<FolioCollaborationSessionState>({
    status: "idle",
    collaboration: null,
  });

  const collabUrl = env.VITE_COLLAB_URL;
  // Read the identity as primitives: callers build the `user` object inline,
  // so depending on the object itself would reconnect on every render.
  const userColor = user?.color ?? null;
  const userName = user?.name ?? null;
  const canConnect =
    enabled &&
    collabUrl !== undefined &&
    userColor !== null &&
    userName !== null;

  useExternalSyncEffect(() => {
    // `canConnect` is a const boolean whose definition includes both null
    // checks, so narrowing flows through it: the identity is non-null below.
    if (!canConnect) {
      setState({ status: "idle", collaboration: null });
      return undefined;
    }

    let disposed = false;
    const isDisposed = () => disposed;
    let provider: HocuspocusProvider | null = null;
    setState({ status: "opening", collaboration: null });

    detached(
      (async () => {
        const { data, error } = await api
          .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
          ["folio-collab-rooms"].join.post({
            entityId: toSafeId<"entity">(entityId),
            propertyId: toSafeId<"property">(propertyId),
          });

        if (isDisposed()) {
          return;
        }

        if (error) {
          setState({
            status: "error",
            collaboration: null,
            message: userErrorMessage(
              error,
              "Failed to open collaborative editing.",
            ),
          });
          return;
        }

        const roomId = data.roomId;
        let token = data.token;

        if (isDisposed()) {
          return;
        }

        let tokenExpiresAtMs = new Date(data.tokenExpiresAt).getTime();
        const seedDocumentBuffer = await (async () => {
          if (!data.shouldSeed) {
            return null;
          }

          if (data.seedDownloadUrl === null) {
            panic("Collaborative editing seed file is unavailable.");
          }

          return await fetchSeedDocumentBuffer(data.seedDownloadUrl);
        })();

        if (isDisposed()) {
          return;
        }

        const collaborationRuntimeModules =
          await loadCollaborationRuntimeModules();
        const { hocuspocus, yProseMirror, yjs } = collaborationRuntimeModules;

        if (isDisposed()) {
          return;
        }

        const refreshTokenIfNeeded = async () => {
          if (
            Number.isFinite(tokenExpiresAtMs) &&
            Date.now() < tokenExpiresAtMs - FOLIO_COLLAB_TOKEN_REFRESH_LEEWAY_MS
          ) {
            return token;
          }

          const refreshed = await api["folio-collab-rooms"][
            "refresh-token"
          ].post({
            roomId,
            token,
          });

          if (refreshed.error) {
            return null;
          }

          token = refreshed.data.token;
          tokenExpiresAtMs = new Date(refreshed.data.tokenExpiresAt).getTime();
          return token;
        };
        const ydoc = new yjs.Doc();
        const yXmlFragment = ydoc.get("prosemirror", yjs.XmlFragment);

        provider = new hocuspocus.HocuspocusProvider({
          document: ydoc,
          name: data.roomName,
          token: async () => (await refreshTokenIfNeeded()) ?? "",
          url: collabUrl,
        });

        const awareness = provider.awareness;
        if (!awareness) {
          provider.destroy();
          setState({
            status: "error",
            collaboration: null,
            message: "Collaboration provider did not expose awareness.",
          });
          return;
        }

        awareness.setLocalStateField("user", {
          color: userColor,
          name: userName,
        });

        const collaboration = {
          awareness,
          plugins: [
            yProseMirror.ySyncPlugin(yXmlFragment),
            yProseMirror.yCursorPlugin(awareness),
            yProseMirror.yUndoPlugin(),
          ],
          shouldSeed: data.shouldSeed,
          yXmlFragment,
        };
        setState({
          status: "ready",
          roomId,
          provider,
          collaboration,
          session: {
            collaboration,
            roomId,
            seedDocumentBuffer,
          },
        });
      })().catch((error: unknown) => {
        if (isDisposed()) {
          return;
        }

        setState({
          status: "error",
          collaboration: null,
          message: userErrorFromThrown(error, t("errors.actionFailed")),
        });
      }),
      "use-folio-collaboration-session.open-session",
    );

    return () => {
      disposed = true;
      provider?.destroy();
    };
  }, [
    canConnect,
    collabUrl,
    entityId,
    propertyId,
    t,
    userColor,
    userName,
    workspaceId,
  ]);

  return state;
};
