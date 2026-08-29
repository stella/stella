import { useState } from "react";

import type { HocuspocusProvider } from "@hocuspocus/provider";
import type * as HocuspocusProviderModule from "@hocuspocus/provider";
import { panic, Result, TaggedError } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";
import type * as YProseMirror from "y-prosemirror";
import type * as Yjs from "yjs";

import {
  FOLIO_COLLAB_GENERATION_RETRY_CLOSE_CODE,
  FOLIO_COLLAB_FLUSH_REQUEST_TYPE,
  FOLIO_COLLAB_FLUSH_RESPONSE_TYPE,
  FOLIO_COLLAB_REDIS_RETRY_CLOSE_CODE,
} from "@stll/api-contract/folio-collab";
import { FetchBoundaryError } from "@stll/errors";
import type { DocxEditorCollaboration } from "@stll/folio-react";

import { env } from "@/env";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { userErrorFromThrown, userErrorMessage } from "@/lib/errors/user-safe";
import { fetchWithTimeout } from "@/lib/fetch";
import { toSafeId } from "@/lib/safe-id";

type ConnectedDocxEditorCollaboration = DocxEditorCollaboration & {
  awareness: NonNullable<DocxEditorCollaboration["awareness"]>;
};

export type FolioCollaborationRoom = {
  collaboration: ConnectedDocxEditorCollaboration;
  flushSnapshot: () => Promise<string>;
  generation: number;
  getStateVectorBase64: () => string;
  roomId: string;
  seedDocumentBuffer: ArrayBuffer | null;
};

type ConnectedRoomState =
  | { status: "connecting"; room: FolioCollaborationRoom }
  | { status: "synced"; room: FolioCollaborationRoom }
  | { status: "reconnecting"; room: FolioCollaborationRoom }
  | { status: "readOnly"; room: FolioCollaborationRoom };

export type FolioCollaborationRoomState =
  | ConnectedRoomState
  | { status: "connecting"; room: null }
  | { status: "unavailable"; room: null; message: string | null };

type UseFolioCollaborationRoomOptions = {
  enabled: boolean;
  entityId: string;
  propertyId: string;
  /** Collaborator identity for awareness; null keeps the local editor path. */
  user: {
    color: string;
    id: string;
    image: string | null;
    name: string;
  } | null;
  workspaceId: string;
};

const FOLIO_COLLAB_TOKEN_REFRESH_LEEWAY_MS = 5 * 60 * 1000;
const SEED_DOCUMENT_DOWNLOAD_TIMEOUT_MS = 10_000;
const COLLAB_FLUSH_TIMEOUT_MS = 10_000;
const GENERATION_REJOIN_RETRY_DELAY_MS = 1000;
const GENERATION_REJOIN_MAX_RETRY_DELAY_MS = 10_000;
const flushResponseSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.strictObject({
    requestId: v.pipe(v.string(), v.uuid()),
    stateVectorBase64: v.string(),
    type: v.literal(FOLIO_COLLAB_FLUSH_RESPONSE_TYPE),
  }),
);

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

const waitForAbortableDelay = async (signal: AbortSignal, delayMs: number) => {
  const retrySignal = AbortSignal.any([signal, AbortSignal.timeout(delayMs)]);
  if (retrySignal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    retrySignal.addEventListener("abort", () => resolve(), { once: true });
  });
};

class CollaborationFlushError extends TaggedError("CollaborationFlushError")<{
  message: string;
}> {}

class CollaborationGenerationRejoinError extends TaggedError(
  "CollaborationGenerationRejoinError",
)<{
  cause: unknown;
  message: string;
}> {}

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

const connectedState = (
  status: ConnectedRoomState["status"],
  room: FolioCollaborationRoom,
): ConnectedRoomState => {
  switch (status) {
    case "connecting":
      return { status: "connecting", room };
    case "synced":
      return { status: "synced", room };
    case "reconnecting":
      return { status: "reconnecting", room };
    case "readOnly":
      return { status: "readOnly", room };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

export const useFolioCollaborationRoom = ({
  enabled,
  entityId,
  propertyId,
  user,
  workspaceId,
}: UseFolioCollaborationRoomOptions): FolioCollaborationRoomState => {
  const t = useTranslations();
  const [state, setState] = useState<FolioCollaborationRoomState>({
    status: "unavailable",
    room: null,
    message: null,
  });

  const collabUrl = env.VITE_COLLAB_URL;
  const userColor = user?.color ?? null;
  const userId = user?.id ?? null;
  const userImage = user?.image ?? null;
  const userName = user?.name ?? null;
  const canConnect =
    enabled &&
    collabUrl !== undefined &&
    userColor !== null &&
    userId !== null &&
    userName !== null;

  useExternalSyncEffect(() => {
    if (!canConnect) {
      setState({ status: "unavailable", room: null, message: null });
      return undefined;
    }

    let disposed = false;
    let hasConnected = false;
    let provider: HocuspocusProvider | null = null;
    let activeRoom: FolioCollaborationRoom | null = null;
    let generationRejoinPromise: Promise<void> | null = null;
    const generationRejoinAbortController = new AbortController();
    const pendingFlushes = new Map<
      string,
      {
        reject: (error: CollaborationFlushError) => void;
        resolve: (stateVectorBase64: string) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const isDisposed = () => disposed;
    const setConnectedState = (status: ConnectedRoomState["status"]) => {
      if (disposed || activeRoom === null) {
        return;
      }
      setState(connectedState(status, activeRoom));
    };
    setState({ status: "connecting", room: null });

    detached(
      (async () => {
        const { data, error: joinError } = await api
          .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
          ["folio-collab-rooms"].join.post({
            entityId: toSafeId<"entity">(entityId),
            propertyId: toSafeId<"property">(propertyId),
          });
        if (isDisposed()) {
          return;
        }
        if (joinError) {
          setState({
            status: "unavailable",
            room: null,
            message: userErrorMessage(joinError, t("folio.editOpenFailed")),
          });
          return;
        }

        const roomId = data.roomId;
        let token = data.token;
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

        const { hocuspocus, yProseMirror, yjs } =
          await loadCollaborationRuntimeModules();
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
          ].post({ roomId, token });
          if (refreshed.error) {
            return null;
          }
          token = refreshed.data.token;
          tokenExpiresAtMs = new Date(refreshed.data.tokenExpiresAt).getTime();
          if (!refreshed.data.canEdit) {
            setConnectedState("readOnly");
          }
          return token;
        };

        const startGenerationRejoin = () => {
          const activeProvider = provider;
          const currentRoom = activeRoom;
          if (
            disposed ||
            activeProvider === null ||
            currentRoom === null ||
            generationRejoinPromise !== null
          ) {
            return;
          }

          activeProvider.disconnect();
          setConnectedState("reconnecting");
          generationRejoinPromise = new Promise<void>((resolve, reject) => {
            let reportedFailure = false;
            let retryDelayMs = GENERATION_REJOIN_RETRY_DELAY_MS;
            const waitForRetry = async () => {
              await waitForAbortableDelay(
                generationRejoinAbortController.signal,
                retryDelayMs,
              );
              retryDelayMs = Math.min(
                retryDelayMs * 2,
                GENERATION_REJOIN_MAX_RETRY_DELAY_MS,
              );
            };
            const runAttempt = () => {
              const attempt = (async () => {
                const rejoinResult = await Result.tryPromise(async () =>
                  api
                    .entities({
                      workspaceId: toSafeId<"workspace">(workspaceId),
                    })
                    ["folio-collab-rooms"].join.post({
                      entityId: toSafeId<"entity">(entityId),
                      propertyId: toSafeId<"property">(propertyId),
                    }),
                );
                if (isDisposed()) {
                  resolve();
                  return;
                }
                if (Result.isError(rejoinResult)) {
                  if (!reportedFailure) {
                    reportedFailure = true;
                    getAnalytics().captureError(rejoinResult.error);
                  }
                  await waitForRetry();
                  if (isDisposed()) {
                    resolve();
                  } else {
                    runAttempt();
                  }
                  return;
                }

                const { data: rejoined, error: rejoinError } =
                  rejoinResult.value;
                if (rejoinError) {
                  const apiError = toAPIError(rejoinError);
                  if (!reportedFailure) {
                    reportedFailure = true;
                    getAnalytics().captureError(apiError);
                  }
                  setConnectedState(
                    apiError.status === 403 ? "readOnly" : "reconnecting",
                  );
                  await waitForRetry();
                  if (isDisposed()) {
                    resolve();
                  } else {
                    runAttempt();
                  }
                  return;
                }
                if (
                  rejoined.roomId !== roomId ||
                  rejoined.roomName !== data.roomName
                ) {
                  panic("Collaboration room identity changed during rejoin.");
                }

                token = rejoined.token;
                tokenExpiresAtMs = new Date(rejoined.tokenExpiresAt).getTime();
                activeRoom = {
                  collaboration: {
                    awareness: currentRoom.collaboration.awareness,
                    plugins: currentRoom.collaboration.plugins,
                    shouldSeed: false,
                    yXmlFragment: currentRoom.collaboration.yXmlFragment,
                  },
                  flushSnapshot: currentRoom.flushSnapshot,
                  generation: rejoined.generation,
                  getStateVectorBase64: currentRoom.getStateVectorBase64,
                  roomId: currentRoom.roomId,
                  seedDocumentBuffer: null,
                };
                setConnectedState("reconnecting");
                detached(
                  activeProvider.connect(),
                  "use-folio-collaboration-room.generation-reconnect",
                );
                resolve();
              })();
              detached(
                attempt.catch((error: unknown) =>
                  reject(
                    new CollaborationGenerationRejoinError({
                      cause: error,
                      message: "Collaboration generation rejoin failed.",
                    }),
                  ),
                ),
                "use-folio-collaboration-room.generation-rejoin-attempt",
              );
            };
            runAttempt();
          })
            .catch((error: unknown) => {
              if (disposed) {
                return;
              }
              getAnalytics().captureError(error);
              setConnectedState("reconnecting");
            })
            .finally(() => {
              generationRejoinPromise = null;
            });
          detached(
            generationRejoinPromise,
            "use-folio-collaboration-room.generation-rejoin",
          );
        };

        const ydoc = new yjs.Doc();
        const yXmlFragment = ydoc.get("prosemirror", yjs.XmlFragment);
        provider = new hocuspocus.HocuspocusProvider({
          document: ydoc,
          name: data.roomName,
          onAuthenticated: ({ scope }) => {
            hasConnected = true;
            if (scope === "readonly") {
              setConnectedState("readOnly");
              return;
            }
            setConnectedState(provider?.isSynced ? "synced" : "connecting");
          },
          onAuthenticationFailed: () => {
            if (disposed || generationRejoinPromise !== null) {
              return;
            }
            if (hasConnected) {
              startGenerationRejoin();
              return;
            }
            setState({
              status: "unavailable",
              room: null,
              message: t("folio.editPermissionDenied"),
            });
          },
          onClose: ({ event }) => {
            if (event.code === FOLIO_COLLAB_GENERATION_RETRY_CLOSE_CODE) {
              startGenerationRejoin();
              return;
            }
            if (
              event.code === FOLIO_COLLAB_REDIS_RETRY_CLOSE_CODE ||
              hasConnected
            ) {
              setConnectedState("reconnecting");
            }
          },
          onStateless: ({ payload }) => {
            const parsed = v.safeParse(flushResponseSchema, payload);
            if (!parsed.success) {
              return;
            }
            const { requestId, stateVectorBase64 } = parsed.output;
            const pending = pendingFlushes.get(requestId);
            if (pending === undefined) {
              return;
            }
            clearTimeout(pending.timer);
            pendingFlushes.delete(requestId);
            pending.resolve(stateVectorBase64);
          },
          onStatus: ({ status }) => {
            if (
              status === hocuspocus.WebSocketStatus.Disconnected ||
              (hasConnected && status === hocuspocus.WebSocketStatus.Connecting)
            ) {
              setConnectedState("reconnecting");
            }
          },
          onSynced: ({ state: isSynced }) => {
            if (!isSynced) {
              setConnectedState("reconnecting");
              return;
            }
            setConnectedState(
              provider?.authorizedScope === "readonly" ? "readOnly" : "synced",
            );
          },
          token: async () => (await refreshTokenIfNeeded()) ?? "",
          url: collabUrl,
        });

        const connectedProvider = provider;
        const awareness = connectedProvider.awareness;
        if (!awareness) {
          connectedProvider.destroy();
          setState({
            status: "unavailable",
            room: null,
            message: t("folio.editOpenFailed"),
          });
          return;
        }
        awareness.setLocalStateField("user", {
          color: userColor,
          id: userId,
          image: userImage,
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
        const flushSnapshot = async () => {
          connectedProvider.flushPendingUpdates();
          const requestId = crypto.randomUUID();
          return await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingFlushes.delete(requestId);
              reject(
                new CollaborationFlushError({
                  message: "Timed out while persisting the collaboration cut.",
                }),
              );
            }, COLLAB_FLUSH_TIMEOUT_MS);
            pendingFlushes.set(requestId, { reject, resolve, timer });
            connectedProvider.sendStateless(
              JSON.stringify({
                requestId,
                type: FOLIO_COLLAB_FLUSH_REQUEST_TYPE,
              }),
            );
          });
        };
        activeRoom = {
          collaboration,
          flushSnapshot,
          generation: data.generation,
          getStateVectorBase64: () =>
            bytesToBase64(yjs.encodeStateVector(ydoc)),
          roomId,
          seedDocumentBuffer,
        };
        if (connectedProvider.authorizedScope === "readonly") {
          setConnectedState("readOnly");
          return;
        }
        setConnectedState(connectedProvider.isSynced ? "synced" : "connecting");
      })().catch((error: unknown) => {
        if (disposed) {
          return;
        }
        setState({
          status: "unavailable",
          room: null,
          message: userErrorFromThrown(error, t("errors.actionFailed")),
        });
      }),
      "use-folio-collaboration-room.join",
    );

    return () => {
      disposed = true;
      generationRejoinAbortController.abort();
      for (const pending of pendingFlushes.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new CollaborationFlushError({
            message: "Collaboration closed before its snapshot was persisted.",
          }),
        );
      }
      pendingFlushes.clear();
      provider?.destroy();
    };
  }, [
    canConnect,
    collabUrl,
    entityId,
    propertyId,
    t,
    userColor,
    userId,
    userImage,
    userName,
    workspaceId,
  ]);

  return state;
};
