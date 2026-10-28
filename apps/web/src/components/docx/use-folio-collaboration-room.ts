import { useRef, useState } from "react";

import type { HocuspocusProvider } from "@hocuspocus/provider";
import type * as HocuspocusProviderModule from "@hocuspocus/provider";
import { panic, Result, TaggedError } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";
import type * as YProseMirror from "y-prosemirror";
import type * as Yjs from "yjs";

import {
  FOLIO_COLLAB_FLUSH_REQUEST_TYPE,
  FOLIO_COLLAB_FLUSH_RESPONSE_TYPE,
  FOLIO_COLLAB_GENERATION_RETRY_CLOSE_CODE,
  FOLIO_COLLAB_REDIS_RETRY_CLOSE_CODE,
  FOLIO_COLLAB_SEED_PREPARING_CODE,
} from "@stll/api-contract/folio-collab";
import { backoffDelay } from "@stll/concurrency/backoff-delay";
import { sleep } from "@stll/concurrency/sleep";
import { FetchBoundaryError } from "@stll/errors";
import { fetchWithTimeout } from "@stll/fetch";
import type { DocxEditorCollaboration } from "@stll/folio-react";
import { Temporal } from "@stll/time";

import { env } from "@/env";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { createUuid } from "@/lib/uuid";

import { advanceFolioCollaborationMutationRevision } from "./folio-collaboration-mutations";
import {
  completeFolioSeedReceipt,
  FolioCollaborationSeedPreparingError,
  waitForFolioCollaborationSeed,
} from "./folio-collaboration-seed-receipt";

type ConnectedDocxEditorCollaboration = DocxEditorCollaboration & {
  awareness: NonNullable<DocxEditorCollaboration["awareness"]>;
};

export type FolioCollaborationRoom = {
  collaboration: ConnectedDocxEditorCollaboration;
  flushSnapshot: () => Promise<FolioCollaborationFlush>;
  generation: number;
  getDocumentMutationRevision: () => number;
  getLocalMutationRevision: () => number;
  roomId: string;
  seedDocumentBuffer: ArrayBuffer;
};

type FolioCollaborationFlush = {
  documentMutationRevision: number;
  localMutationRevision: number;
  snapshotRevision: number;
};

type ConnectedRoomState =
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
// Peers receive the server-derived color; the local cursor is never rendered.
const LOCAL_AWARENESS_PLACEHOLDER_COLOR = "#000000";
const flushResponseSchema = v.pipe(
  v.string(),
  v.parseJson(),
  v.strictObject({
    requestId: v.pipe(v.string(), v.uuid()),
    snapshotRevision: v.pipe(v.number(), v.integer(), v.minValue(0)),
    type: v.literal(FOLIO_COLLAB_FLUSH_RESPONSE_TYPE),
  }),
);
const joinResponseSchema = v.object({
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  roomId: v.string(),
  roomName: v.string(),
  seedDownloadUrl: v.string(),
  shouldSeed: v.boolean(),
  snapshotRecovery: v.picklist(["none", "unsaved-changes-discarded"]),
  token: v.string(),
  tokenExpiresAt: v.string(),
});
type JoinedFolioCollaborationRoom = v.InferOutput<typeof joinResponseSchema>;

const refreshResponseSchema = v.object({
  canEdit: v.boolean(),
  generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
  token: v.string(),
  tokenExpiresAt: v.string(),
});

const throwIfCollaborationSeedIsPreparing = (
  error: {
    status: number;
    value: unknown;
  } | null,
) => {
  if (error?.status !== 409) {
    return;
  }
  const preparing = v.safeParse(
    v.object({ code: v.literal(FOLIO_COLLAB_SEED_PREPARING_CODE) }),
    error.value,
  );
  if (preparing.success) {
    throw new FolioCollaborationSeedPreparingError({
      message: "Collaborative editing room is still preparing.",
    });
  }
};

const joinFolioCollaborationRoom = async ({
  entityId,
  propertyId,
  workspaceId,
}: {
  entityId: string;
  propertyId: string;
  workspaceId: string;
}) => {
  const entitiesRoute = api.entities({ workspaceId });
  const response = await entitiesRoute["folio-collab-rooms"].join.post({
    entityId,
    propertyId,
  });
  throwIfCollaborationSeedIsPreparing(response.error);
  return unwrapApiResponse(response);
};

const refreshFolioCollaborationToken = async (body: {
  roomId: string;
  token: string;
}) => {
  const response = await api["folio-collab-rooms"]["refresh-token"].post(body);
  throwIfCollaborationSeedIsPreparing(response.error);
  return unwrapApiResponse(response);
};

const acknowledgeFolioCollaborationSeed = async (body: {
  roomId: string;
  token: string;
  snapshotSha256Hex: string;
}) => {
  const response = await api["folio-collab-rooms"].snapshot.seed.post(body);
  throwIfCollaborationSeedIsPreparing(response.error);
  return unwrapApiResponse(response);
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
    case "synced":
      return { status: "synced", room };
    case "reconnecting":
      return { status: "reconnecting", room };
    case "readOnly":
      return { status: "readOnly", room };
    default: {
      status satisfies never;
      return panic(`Unhandled status: ${String(status)}`);
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
  const getActionFailedMessage = useLatestCallback(() =>
    t("errors.actionFailed"),
  );
  const getEditOpenFailedMessage = useLatestCallback(() =>
    t("folio.editOpenFailed"),
  );
  const getEditPermissionDeniedMessage = useLatestCallback(() =>
    t("folio.editPermissionDenied"),
  );
  const getSnapshotRecoveryMessage = useLatestCallback(() =>
    t("folio.collaborationSnapshotRecovered"),
  );
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const pendingGenerationJoin = useRef<{
    targetKey: string;
    response: JoinedFolioCollaborationRoom;
  } | null>(null);
  const targetKey = JSON.stringify([
    workspaceId,
    entityId,
    propertyId,
    user?.id,
  ]);
  const [state, setState] = useState<FolioCollaborationRoomState>({
    status: "unavailable",
    room: null,
    message: null,
  });

  const collabUrl = env.VITE_COLLAB_URL;
  const userId = user?.id ?? null;
  const userImage = user?.image ?? null;
  const userName = user?.name ?? null;
  const getAwarenessUser = useLatestCallback(() => {
    if (userId === null || userName === null) {
      return null;
    }
    return {
      color: LOCAL_AWARENESS_PLACEHOLDER_COLOR,
      id: userId,
      image: userImage,
      name: userName,
    };
  });
  const canConnect =
    enabled && collabUrl !== undefined && userId !== null && userName !== null;

  useExternalSyncEffect(() => {
    if (!canConnect) {
      setState({ status: "unavailable", room: null, message: null });
      return undefined;
    }

    let disposed = false;
    let hasConnected = false;
    let hasSynchronized = false;
    let seedReceipt: "pending" | "acknowledged" = "pending";
    let provider: HocuspocusProvider | null = null;
    let collaborationDocument: Yjs.Doc | null = null;
    let activeRoom: FolioCollaborationRoom | null = null;
    let generationRejoinPromise: Promise<void> | null = null;
    const generationRejoinAbortController = new AbortController();
    const seedReceiptAbortController = new AbortController();
    const pendingFlushes = new Map<
      string,
      {
        reject: (error: CollaborationFlushError) => void;
        resolve: (snapshotRevision: number) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    const isDisposed = () => disposed;
    const setConnectedState = (
      status: ConnectedRoomState["status"] | "connecting",
    ) => {
      if (disposed || activeRoom === null) {
        return;
      }
      // A non-seeding editor must receive the Yjs source contract before binding.
      // Keep the existing document available during later reconnects.
      if (!hasSynchronized) {
        setState({ status: "connecting", room: null });
        return;
      }
      if (seedReceipt === "pending") {
        setState(connectedState("readOnly", activeRoom));
        return;
      }
      setState(
        connectedState(
          status === "connecting" ? "reconnecting" : status,
          activeRoom,
        ),
      );
    };
    setState({ status: "connecting", room: null });

    detached(
      (async () => {
        const cachedJoin = pendingGenerationJoin.current;
        pendingGenerationJoin.current = null;
        const data =
          cachedJoin?.targetKey === targetKey
            ? cachedJoin.response
            : (
                await waitForFolioCollaborationSeed({
                  join: async () =>
                    v.parse(
                      joinResponseSchema,
                      await joinFolioCollaborationRoom({
                        entityId,
                        propertyId,
                        workspaceId,
                      }),
                    ),
                  signal: generationRejoinAbortController.signal,
                })
              ).unwrap("Collaborative room preparation failed");
        if (isDisposed()) {
          return;
        }
        if (data.snapshotRecovery === "unsaved-changes-discarded") {
          notifyUserError(undefined, getSnapshotRecoveryMessage());
        }

        seedReceipt = data.shouldSeed ? "pending" : "acknowledged";
        const roomId = data.roomId;
        let token = data.token;
        let tokenExpiresAtMs = new Date(data.tokenExpiresAt).getTime();
        let synchronizedStatus: "readOnly" | "synced" = "synced";
        const seedDocumentBuffer = await fetchSeedDocumentBuffer(
          data.seedDownloadUrl,
        );
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
            Temporal.Now.instant().epochMilliseconds <
              tokenExpiresAtMs - FOLIO_COLLAB_TOKEN_REFRESH_LEEWAY_MS
          ) {
            return token;
          }
          const refreshed = v.parse(
            refreshResponseSchema,
            await refreshFolioCollaborationToken({ roomId, token }),
          );
          token = refreshed.token;
          tokenExpiresAtMs = new Date(refreshed.tokenExpiresAt).getTime();
          if (!refreshed.canEdit) {
            synchronizedStatus = "readOnly";
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
              const waited = await Result.tryPromise({
                try: async () =>
                  await sleep(retryDelayMs, {
                    signal: generationRejoinAbortController.signal,
                  }),
                catch: (cause) => cause,
              });
              if (Result.isError(waited)) {
                const { signal } = generationRejoinAbortController;
                if (
                  !signal.aborted ||
                  !Object.is(waited.error, signal.reason)
                ) {
                  return waited;
                }
              }
              retryDelayMs = backoffDelay(1, {
                baseMs: retryDelayMs,
                maxMs: GENERATION_REJOIN_MAX_RETRY_DELAY_MS,
              });
              return Result.ok(undefined);
            };
            const runAttempt = () => {
              const attempt = (async () => {
                const rejoinResult = await Result.tryPromise({
                  try: async () =>
                    v.parse(
                      joinResponseSchema,
                      await joinFolioCollaborationRoom({
                        entityId,
                        propertyId,
                        workspaceId,
                      }),
                    ),
                  catch: (cause) => cause,
                });
                if (isDisposed()) {
                  resolve();
                  return;
                }
                if (Result.isError(rejoinResult)) {
                  const status =
                    rejoinResult.error instanceof FetchBoundaryError
                      ? rejoinResult.error.status
                      : null;
                  if (!reportedFailure) {
                    reportedFailure = true;
                    getAnalytics().captureError(rejoinResult.error, {
                      fingerprintKey:
                        "useFolioCollaborationRoom.startGenerationRejoin.runAttempt:failure",
                      scope: {
                        type: "handler",
                        handlerId:
                          "useFolioCollaborationRoom.startGenerationRejoin.runAttempt:failure",
                      },
                    });
                  }
                  if (status === 403) {
                    setConnectedState("readOnly");
                    resolve();
                    return;
                  }
                  const waited = await waitForRetry();
                  if (Result.isError(waited)) {
                    reject(
                      new CollaborationGenerationRejoinError({
                        cause: waited.error,
                        message: "Collaboration generation retry failed.",
                      }),
                    );
                    return;
                  }
                  if (isDisposed()) {
                    resolve();
                  } else {
                    runAttempt();
                  }
                  return;
                }

                const rejoined = rejoinResult.value;
                if (
                  rejoined.roomId !== roomId ||
                  rejoined.roomName !== data.roomName
                ) {
                  panic("Collaboration room identity changed during rejoin.");
                }

                if (rejoined.generation !== currentRoom.generation) {
                  seedReceiptAbortController.abort();
                  pendingGenerationJoin.current = {
                    targetKey,
                    response: rejoined,
                  };
                  setConnectionAttempt(
                    (previousAttempt) => previousAttempt + 1,
                  );
                  resolve();
                  return;
                }

                if (!rejoined.shouldSeed) {
                  seedReceipt = "acknowledged";
                }
                token = rejoined.token;
                tokenExpiresAtMs = new Date(rejoined.tokenExpiresAt).getTime();
                activeRoom = {
                  collaboration: currentRoom.collaboration,
                  flushSnapshot: currentRoom.flushSnapshot,
                  generation: rejoined.generation,
                  getDocumentMutationRevision:
                    currentRoom.getDocumentMutationRevision,
                  getLocalMutationRevision:
                    currentRoom.getLocalMutationRevision,
                  roomId: currentRoom.roomId,
                  seedDocumentBuffer: currentRoom.seedDocumentBuffer,
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
              getAnalytics().captureError(error, {
                fingerprintKey:
                  "useFolioCollaborationRoom.startGenerationRejoin:failure",
                scope: {
                  type: "handler",
                  handlerId:
                    "useFolioCollaborationRoom.startGenerationRejoin:failure",
                },
              });
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
        collaborationDocument = ydoc;
        const yXmlFragment = ydoc.get("prosemirror", yjs.XmlFragment);
        provider = new hocuspocus.HocuspocusProvider({
          document: ydoc,
          name: data.roomName,
          onAuthenticated: ({ scope }) => {
            hasConnected = true;
            if (scope === "readonly") {
              synchronizedStatus = "readOnly";
              setConnectedState("readOnly");
              return;
            }
            synchronizedStatus = "synced";
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
              message: getEditPermissionDeniedMessage(),
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
            const { requestId, snapshotRevision } = parsed.output;
            const pending = pendingFlushes.get(requestId);
            if (pending === undefined) {
              return;
            }
            clearTimeout(pending.timer);
            pendingFlushes.delete(requestId);
            pending.resolve(snapshotRevision);
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
            hasSynchronized = true;
            setConnectedState(synchronizedStatus);
          },
          token: refreshTokenIfNeeded,
          url: collabUrl,
        });

        const connectedProvider = provider;
        const awareness = connectedProvider.awareness;
        if (!awareness) {
          connectedProvider.destroy();
          setState({
            status: "unavailable",
            room: null,
            message: getEditOpenFailedMessage(),
          });
          return;
        }
        const awarenessUser = getAwarenessUser();
        if (awarenessUser === null) {
          panic("Collaboration awareness identity is unavailable.");
        }
        awareness.setLocalStateField("user", awarenessUser);

        let mutationRevision = { document: 0, local: 0 };
        ydoc.on("afterTransaction", (transaction) => {
          mutationRevision = advanceFolioCollaborationMutationRevision({
            current: mutationRevision,
            hasChanges:
              transaction.changed.size > 0 ||
              transaction.deleteSet.clients.size > 0,
            local: transaction.local,
          });
        });

        const acknowledgeSeed = (seedBytes: Uint8Array) => {
          const isCurrentReceipt = () =>
            !disposed &&
            !seedReceiptAbortController.signal.aborted &&
            provider === connectedProvider &&
            activeRoom?.generation === data.generation;
          let reportedFailure = false;
          const reportFailure = (error: unknown) => {
            if (reportedFailure || !isCurrentReceipt()) {
              return;
            }
            reportedFailure = true;
            getAnalytics().captureError(error, {
              fingerprintKey:
                "useFolioCollaborationRoom.acknowledgeSeed:failure",
              scope: {
                type: "handler",
                handlerId: "useFolioCollaborationRoom.acknowledgeSeed:failure",
              },
            });
            notifyUserError(error, getEditOpenFailedMessage());
          };
          detached(
            completeFolioSeedReceipt({
              snapshotBytes: seedBytes,
              acknowledge: async (snapshotSha256Hex) => {
                await refreshTokenIfNeeded();
                if (!isCurrentReceipt()) {
                  return;
                }
                await acknowledgeFolioCollaborationSeed({
                  roomId,
                  token,
                  snapshotSha256Hex,
                });
              },
              flushSnapshot,
              isCurrent: isCurrentReceipt,
              onRetry: reportFailure,
              signal: seedReceiptAbortController.signal,
            })
              .then((receipt) => {
                if (!isCurrentReceipt()) {
                  return undefined;
                }
                switch (receipt.status) {
                  case "acknowledged":
                    seedReceipt = "acknowledged";
                    setConnectedState(
                      connectedProvider.isSynced
                        ? synchronizedStatus
                        : "connecting",
                    );
                    return undefined;
                  case "superseded":
                    return undefined;
                  case "failed":
                    if (
                      receipt.error instanceof FetchBoundaryError &&
                      receipt.error.status === 409
                    ) {
                      startGenerationRejoin();
                      return undefined;
                    }
                    reportFailure(receipt.error);
                    if (
                      receipt.error instanceof FetchBoundaryError &&
                      receipt.error.status === 403
                    ) {
                      return undefined;
                    }
                    connectedProvider.disconnect();
                    setState({
                      status: "unavailable",
                      room: null,
                      message: getEditOpenFailedMessage(),
                    });
                    return undefined;
                  default:
                    receipt satisfies never;
                    return panic("Unhandled seed receipt outcome");
                }
              })
              .catch(reportFailure),
            "use-folio-collaboration-room.seed-receipt",
          );
        };

        const collaboration = {
          awareness,
          // Capture before the first editable view or another participant can mutate the seed.
          onSeeded: () => acknowledgeSeed(yjs.encodeStateAsUpdate(ydoc)),
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
          const documentMutationRevisionAtRequest = mutationRevision.document;
          const localMutationRevisionAtRequest = mutationRevision.local;
          const requestId = createUuid();
          const snapshotRevision = await new Promise<number>(
            (resolve, reject) => {
              const timer = setTimeout(() => {
                pendingFlushes.delete(requestId);
                reject(
                  new CollaborationFlushError({
                    message:
                      "Timed out while persisting the collaboration cut.",
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
            },
          );
          return {
            documentMutationRevision: documentMutationRevisionAtRequest,
            localMutationRevision: localMutationRevisionAtRequest,
            snapshotRevision,
          };
        };
        activeRoom = {
          collaboration,
          flushSnapshot,
          generation: data.generation,
          getDocumentMutationRevision: () => mutationRevision.document,
          getLocalMutationRevision: () => mutationRevision.local,
          roomId,
          seedDocumentBuffer,
        };
        if (connectedProvider.isSynced) {
          hasSynchronized = true;
        }
        setConnectedState(
          connectedProvider.isSynced ? synchronizedStatus : "connecting",
        );
      })().catch((error: unknown) => {
        if (disposed) {
          return;
        }
        setState({
          status: "unavailable",
          room: null,
          message: userErrorFromThrown(error, getActionFailedMessage()),
        });
      }),
      "use-folio-collaboration-room.join",
    );

    return () => {
      disposed = true;
      generationRejoinAbortController.abort();
      seedReceiptAbortController.abort();
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
      collaborationDocument?.destroy();
    };
  }, [
    canConnect,
    collabUrl,
    connectionAttempt,
    targetKey,
    entityId,
    getActionFailedMessage,
    getAwarenessUser,
    getEditOpenFailedMessage,
    getEditPermissionDeniedMessage,
    getSnapshotRecoveryMessage,
    propertyId,
    workspaceId,
  ]);

  return state;
};
