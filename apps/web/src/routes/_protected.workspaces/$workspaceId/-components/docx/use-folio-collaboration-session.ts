import { useEffect, useMemo, useState } from "react";

import { HocuspocusProvider } from "@hocuspocus/provider";
import { useQueryClient } from "@tanstack/react-query";
import { yCursorPlugin, ySyncPlugin, yUndoPlugin } from "y-prosemirror";
import * as Y from "yjs";

import type { DocxEditorCollaboration } from "@stll/folio";

import { env } from "@/env";
import { api } from "@/lib/api";
import { DOCX_MIME } from "@/lib/consts";
import { userErrorMessage } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { filesKeys } from "@/routes/_protected.workspaces/$workspaceId/-components/files/queries";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

type FinalizeFolioCollaborationSessionResult =
  | {
      outcome: "finalized";
      entityId: string;
      fieldId: string;
      versionId: string;
      versionNumber: number;
    }
  | { outcome: "no_changes" };

export type FolioCollaborationSession = {
  cancel: () => Promise<boolean>;
  collaboration: DocxEditorCollaboration;
  finalize: () => Promise<FinalizeFolioCollaborationSessionResult | null>;
  saveCheckpoint: (docxBuffer: ArrayBuffer) => Promise<boolean>;
  seedDocumentBuffer: ArrayBuffer | null;
  sessionId: string;
};

type FolioCollaborationSessionState =
  | { status: "idle"; collaboration: null }
  | { status: "opening"; collaboration: null }
  | {
      status: "ready";
      collaboration: DocxEditorCollaboration;
      provider: HocuspocusProvider;
      session: FolioCollaborationSession;
      sessionId: string;
    }
  | { status: "error"; collaboration: null; message: string };

type UseFolioCollaborationSessionOptions = {
  enabled: boolean;
  entityId: string;
  fieldId: string;
  propertyId: string;
  user: {
    color: string;
    name: string;
  };
  workspaceId: string;
};

const FOLIO_COLLAB_TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const SEED_DOCUMENT_DOWNLOAD_TIMEOUT_MS = 10_000;

const fetchSeedDocumentBuffer = async (seedDownloadUrl: string) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    SEED_DOCUMENT_DOWNLOAD_TIMEOUT_MS,
  );

  try {
    const response = await fetch(seedDownloadUrl, {
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error("Failed to download collaborative editing seed file.");
    }

    return await response.arrayBuffer();
  } finally {
    clearTimeout(timeoutId);
  }
};

export const useFolioCollaborationSession = ({
  enabled,
  entityId,
  fieldId,
  propertyId,
  user,
  workspaceId,
}: UseFolioCollaborationSessionOptions): FolioCollaborationSessionState => {
  const queryClient = useQueryClient();
  const [state, setState] = useState<FolioCollaborationSessionState>({
    status: "idle",
    collaboration: null,
  });

  const collabUrl = env.VITE_COLLAB_URL;
  const canConnect = enabled && collabUrl !== undefined;

  useEffect(() => {
    if (!canConnect) {
      setState({ status: "idle", collaboration: null });
      return undefined;
    }

    let disposed = false;
    const isDisposed = () => disposed;
    let provider: HocuspocusProvider | null = null;
    let openingSession: { sessionId: string; token: string } | null = null;
    const cancelOpeningSession = async () => {
      const session = openingSession;
      if (session === null) {
        return;
      }

      openingSession = null;
      try {
        await api["folio-collab-sessions"]({
          sessionId: session.sessionId,
        }).cancel.post({ token: session.token });
      } catch {
        // Best-effort cleanup for abandoned session opens.
      }
    };
    setState({ status: "opening", collaboration: null });

    void (async () => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["folio-collab-sessions"].open.post({
          entityId: toSafeId<"entity">(entityId),
          propertyId: toSafeId<"property">(propertyId),
        });

      if (isDisposed()) {
        return;
      }

      if (response.error) {
        setState({
          status: "error",
          collaboration: null,
          message: userErrorMessage(
            response.error,
            "Failed to open collaborative editing.",
          ),
        });
        return;
      }

      const sessionId = response.data.collabSessionId;
      let token = response.data.token;
      openingSession = { sessionId, token };

      if (isDisposed()) {
        await cancelOpeningSession();
        return;
      }

      let tokenExpiresAtMs = Date.parse(response.data.tokenExpiresAt);
      const seedDocumentBuffer = await (async () => {
        if (!response.data.shouldSeed) {
          return null;
        }

        if (response.data.seedDownloadUrl === null) {
          throw new Error("Collaborative editing seed file is unavailable.");
        }

        return await fetchSeedDocumentBuffer(response.data.seedDownloadUrl);
      })();

      if (isDisposed()) {
        await cancelOpeningSession();
        return;
      }

      const refreshTokenIfNeeded = async () => {
        if (
          Number.isFinite(tokenExpiresAtMs) &&
          Date.now() < tokenExpiresAtMs - FOLIO_COLLAB_TOKEN_REFRESH_LEEWAY_MS
        ) {
          return token;
        }

        const refreshed = await api
          .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
          ["folio-collab-sessions"].open.post({
            entityId: toSafeId<"entity">(entityId),
            propertyId: toSafeId<"property">(propertyId),
          });

        if (refreshed.error || refreshed.data.collabSessionId !== sessionId) {
          return null;
        }

        token = refreshed.data.token;
        tokenExpiresAtMs = Date.parse(refreshed.data.tokenExpiresAt);
        return token;
      };
      const ydoc = new Y.Doc();
      const yXmlFragment = ydoc.get("prosemirror", Y.XmlFragment);

      provider = new HocuspocusProvider({
        document: ydoc,
        name: response.data.roomName,
        token: async () => (await refreshTokenIfNeeded()) ?? "",
        url: collabUrl,
      });

      const awareness = provider.awareness;
      if (!awareness) {
        await cancelOpeningSession();
        provider.destroy();
        setState({
          status: "error",
          collaboration: null,
          message: "Collaboration provider did not expose awareness.",
        });
        return;
      }

      awareness.setLocalStateField("user", {
        color: user.color,
        name: user.name,
      });

      const invalidateSessionQueries = async () => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: entitiesKeys.all(workspaceId),
          }),
          queryClient.invalidateQueries({
            queryKey: filesKeys.byFieldId({
              workspaceId,
              fieldId,
              purpose: "native-display",
            }),
          }),
          queryClient.invalidateQueries({
            queryKey: filesKeys.metadataByFieldId({
              workspaceId,
              fieldId,
              purpose: "native-display",
            }),
          }),
        ]);
      };
      const cancel = async () => {
        const freshToken = await refreshTokenIfNeeded();
        if (freshToken === null) {
          return false;
        }

        const cancelled = await api["folio-collab-sessions"]({
          sessionId,
        }).cancel.post({ token: freshToken });

        if (cancelled.error) {
          return false;
        }

        await invalidateSessionQueries();
        return true;
      };
      const saveCheckpoint = async (docxBuffer: ArrayBuffer) => {
        const freshToken = await refreshTokenIfNeeded();
        if (freshToken === null) {
          return false;
        }

        const checkpoint = await api["folio-collab-sessions"]({
          sessionId,
        }).checkpoint.post({
          file: new File([docxBuffer], response.data.fileName, {
            type: DOCX_MIME,
          }),
          token: freshToken,
        });

        return !checkpoint.error;
      };
      const finalize = async () => {
        const freshToken = await refreshTokenIfNeeded();
        if (freshToken === null) {
          return null;
        }

        const finalized = await api["folio-collab-sessions"]({
          sessionId,
        }).finalize.post({ token: freshToken });

        if (finalized.error) {
          return null;
        }

        const finalizedFieldId =
          finalized.data.outcome === "finalized"
            ? finalized.data.fieldId
            : fieldId;
        await Promise.all(
          [
            invalidateSessionQueries(),
            finalizedFieldId !== fieldId
              ? queryClient.invalidateQueries({
                  queryKey: filesKeys.byFieldId({
                    workspaceId,
                    fieldId: finalizedFieldId,
                    purpose: "native-display",
                  }),
                })
              : null,
            finalizedFieldId !== fieldId
              ? queryClient.invalidateQueries({
                  queryKey: filesKeys.metadataByFieldId({
                    workspaceId,
                    fieldId: finalizedFieldId,
                    purpose: "native-display",
                  }),
                })
              : null,
          ].filter((promise) => promise !== null),
        );

        return finalized.data;
      };
      const collaboration = {
        awareness,
        plugins: [
          ySyncPlugin(yXmlFragment),
          yCursorPlugin(awareness),
          yUndoPlugin(),
        ],
        shouldSeed: response.data.shouldSeed,
        yXmlFragment,
      };
      openingSession = null;

      setState({
        status: "ready",
        sessionId,
        provider,
        collaboration,
        session: {
          cancel,
          collaboration,
          finalize,
          saveCheckpoint,
          seedDocumentBuffer,
          sessionId,
        },
      });
    })().catch((error: unknown) => {
      void cancelOpeningSession();
      if (isDisposed()) {
        return;
      }

      setState({
        status: "error",
        collaboration: null,
        message:
          error instanceof Error
            ? error.message
            : "Failed to open collaborative editing.",
      });
    });

    return () => {
      disposed = true;
      void cancelOpeningSession();
      provider?.destroy();
    };
  }, [
    canConnect,
    collabUrl,
    entityId,
    fieldId,
    propertyId,
    queryClient,
    user.color,
    user.name,
    workspaceId,
  ]);

  return useMemo(() => state, [state]);
};
