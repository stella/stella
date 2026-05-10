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
  collaboration: DocxEditorCollaboration;
  finalize: () => Promise<FinalizeFolioCollaborationSessionResult | null>;
  saveCheckpoint: (docxBuffer: ArrayBuffer) => Promise<boolean>;
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
    if (!canConnect || collabUrl === undefined) {
      setState({ status: "idle", collaboration: null });
      return undefined;
    }

    let disposed = false;
    let provider: HocuspocusProvider | null = null;
    setState({ status: "opening", collaboration: null });

    void (async () => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        ["folio-collab-sessions"].open.post({
          entityId: toSafeId<"entity">(entityId),
          propertyId: toSafeId<"property">(propertyId),
        });

      if (disposed) {
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

      const ydoc = new Y.Doc();
      const yXmlFragment = ydoc.get("prosemirror", Y.XmlFragment);

      provider = new HocuspocusProvider({
        document: ydoc,
        name: response.data.roomName,
        token: response.data.token,
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
        color: user.color,
        name: user.name,
      });

      const sessionId = response.data.collabSessionId;
      const token = response.data.token;
      const saveCheckpoint = async (docxBuffer: ArrayBuffer) => {
        const checkpoint = await api["folio-collab-sessions"]({
          sessionId,
        }).checkpoint.post({
          file: new File([docxBuffer], response.data.fileName, {
            type: DOCX_MIME,
          }),
          token,
        });

        return !checkpoint.error;
      };
      const finalize = async () => {
        const finalized = await api["folio-collab-sessions"]({
          sessionId,
        }).finalize.post({ token });

        if (finalized.error) {
          return null;
        }

        const finalizedFieldId =
          finalized.data.outcome === "finalized"
            ? finalized.data.fieldId
            : fieldId;
        await Promise.all(
          [
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

      setState({
        status: "ready",
        sessionId,
        provider,
        collaboration,
        session: {
          collaboration,
          finalize,
          saveCheckpoint,
        },
      });
    })().catch((error: unknown) => {
      if (disposed) {
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
