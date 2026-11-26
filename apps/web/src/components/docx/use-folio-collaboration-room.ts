import { useRef, useState } from "react";

import type { HocuspocusProvider } from "@hocuspocus/provider";
import type * as HocuspocusProviderModule from "@hocuspocus/provider";
import { panic, Result, TaggedError } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";
import type { Awareness } from "y-protocols/awareness";
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
import { canonicalSnapshotId } from "@stll/folio-core/canonical/canonicalRoomBase";
import type { CanonicalRoomCollaboration } from "@stll/folio-core/controller/canonicalRoomEditor";
import {
  type CanonicalYjsConnection,
  openCanonicalYjsRoom,
} from "@stll/folio-core/controller/canonicalYjsRoom";
import { Temporal } from "@stll/time";
import { useExternalSyncEffect, useLatestCallback } from "@stll/ui/effects";

import { env } from "@/env";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { APIError, unwrapApiResponse } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError, notifyUserProblem } from "@/lib/errors/user-toast";
import { createUuid } from "@/lib/uuid";

import { advanceFolioCollaborationMutationRevision } from "./folio-collaboration-mutations";
import {
  completeFolioSeedReceipt,
  FolioCollaborationSeedPreparingError,
  waitForFolioCollaborationSeed,
} from "./folio-collaboration-seed-receipt";

export type FolioCollaborationRoom = {
  /** The provider's awareness: who is in the room, as the server vouches. */
  awareness: Awareness;
  collaboration: CanonicalRoomCollaboration;
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
const COLLAB_API_TIMEOUT_MS = 10_000;
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
  signal,
}: {
  entityId: string;
  propertyId: string;
  workspaceId: string;
  signal?: AbortSignal;
}) => {
  const entitiesRoute = api.entities({ workspaceId });
  const response = await invokeAppOnlyWrite(
    "folio-collaboration.join",
    async () => {
      const result = await entitiesRoute["folio-collab-rooms"].join.post(
        { entityId, propertyId },
        {
          fetch: {
            ...(signal === undefined ? {} : { signal }),
            timeoutMs: COLLAB_API_TIMEOUT_MS,
          },
        },
      );
      throwIfCollaborationSeedIsPreparing(result.error);
      return unwrapApiResponse(result);
    },
  );
  return response;
};

const refreshFolioCollaborationToken = async (body: {
  roomId: string;
  token: string;
}) => {
  const response = await invokeAppOnlyWrite(
    "folio-collaboration.refresh-token",
    async () => {
      const result = await api["folio-collab-rooms"]["refresh-token"].post(
        body,
        {
          fetch: { timeoutMs: COLLAB_API_TIMEOUT_MS },
        },
      );
      throwIfCollaborationSeedIsPreparing(result.error);
      return unwrapApiResponse(result);
    },
  );
  return response;
};

const acknowledgeFolioCollaborationSeed = async (body: {
  roomId: string;
  token: string;
  snapshotSha256Hex: string;
}) => {
  const response = await invokeAppOnlyWrite(
    "folio-collaboration.seed.acknowledge",
    async () => {
      const result = await api["folio-collab-rooms"].snapshot.seed.post(body, {
        fetch: { timeoutMs: COLLAB_API_TIMEOUT_MS },
      });
      throwIfCollaborationSeedIsPreparing(result.error);
      return unwrapApiResponse(result);
    },
  );
  return response;
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
  yjs: typeof Yjs;
};

let collaborationRuntimeModulesPromise: Promise<CollaborationRuntimeModules> | null =
  null;

const loadCollaborationRuntimeModules =
  async (): Promise<CollaborationRuntimeModules> => {
    collaborationRuntimeModulesPromise ??= Promise.all([
      import("@hocuspocus/provider"),
      import("yjs"),
    ])
      .then(([hocuspocus, yjs]) => ({
        hocuspocus,
        yjs,
      }))
      .catch((error: unknown) => {
        collaborationRuntimeModulesPromise = null;
        throw error;
      });

    return await collaborationRuntimeModulesPromise;
  };

// Seed downloads fail as FetchBoundaryError, typed API calls as APIError;
// rejoin and read-only recovery branch on the HTTP status of either.
const httpFailureStatus = (error: unknown): number | null =>
  error instanceof FetchBoundaryError || APIError.is(error)
    ? (error.status ?? null)
    : null;

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

/** A room connection the provider's events switch on and off. */
const createRoomConnection = (): {
  connection: CanonicalYjsConnection;
  setConnected: (connected: boolean) => void;
} => {
  let connected = false;
  const listeners = new Set<(connected: boolean) => void>();
  return {
    connection: {
      get connected() {
        return connected;
      },
      onChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    setConnected: (next) => {
      if (connected === next) {
        return;
      }
      connected = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
  };
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
  const getEditRefusedMessage = useLatestCallback(() =>
    t("folio.collaborationEditRefused"),
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
                        signal: generationRejoinAbortController.signal,
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
          notifyUserProblem(getSnapshotRecoveryMessage());
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

        const { hocuspocus, yjs } = await loadCollaborationRuntimeModules();
        // The room was seeded from these bytes; a room seeded from others
        // refuses the editor.
        const roomSnapshot = await canonicalSnapshotId(seedDocumentBuffer);
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
                        signal: generationRejoinAbortController.signal,
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
                  const status = httpFailureStatus(rejoinResult.error);
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
                  awareness: currentRoom.awareness,
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
        // The room follows the journal while the provider is synced with the
        // server; its requests wait in the document's inbox otherwise.
        const { connection: roomConnection, setConnected: setRoomConnected } =
          createRoomConnection();
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
            setRoomConnected(false);
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
              setRoomConnected(false);
              setConnectedState("reconnecting");
            }
          },
          onSynced: ({ state: isSynced }) => {
            setRoomConnected(isSynced);
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
                    if (httpFailureStatus(receipt.error) === 409) {
                      startGenerationRejoin();
                      return undefined;
                    }
                    reportFailure(receipt.error);
                    if (httpFailureStatus(receipt.error) === 403) {
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

        // Local batches the room has not sequenced yet. A durable cut waits
        // for them, so the stored state holds every edit made before it.
        let unsequencedBatches = 0;
        const sequencedWaiters = new Map<
          () => void,
          ReturnType<typeof setTimeout>
        >();
        const whenLocalEditsSequenced = async (): Promise<void> => {
          if (unsequencedBatches === 0) {
            return;
          }
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              sequencedWaiters.delete(resolve);
              reject(
                new CollaborationFlushError({
                  message:
                    "Timed out while the room sequenced this editor's edits.",
                }),
              );
            }, COLLAB_FLUSH_TIMEOUT_MS);
            sequencedWaiters.set(resolve, timer);
          });
        };
        let seedAcknowledgementStarted = false;
        const collaboration: CanonicalRoomCollaboration = {
          snapshot: roomSnapshot,
          // A fresh actor per connection; the server vouches for the user part.
          actor: `${awarenessUser.id}:${createUuid()}`,
          user: {
            color: LOCAL_AWARENESS_PLACEHOLDER_COLOR,
            name: awarenessUser.name,
          },
          connect: () =>
            openCanonicalYjsRoom({
              awareness,
              connection: roomConnection,
              doc: ydoc,
              snapshot: roomSnapshot,
            }),
          onEvent: (event) => {
            switch (event.type) {
              case "synced":
                // The authority seeded the room before it answered this
                // editor: capture that pristine state as the seed receipt.
                if (seedReceipt === "pending" && !seedAcknowledgementStarted) {
                  seedAcknowledgementStarted = true;
                  acknowledgeSeed(yjs.encodeStateAsUpdate(ydoc));
                }
                return;
              case "pending":
                unsequencedBatches = event.batches;
                if (unsequencedBatches === 0) {
                  for (const [resolve, timer] of sequencedWaiters) {
                    clearTimeout(timer);
                    resolve();
                  }
                  sequencedWaiters.clear();
                }
                return;
              case "localEditRefused":
              case "leaseRefused":
                // The editor took the edit back out of the document.
                notifyUserProblem(getEditRefusedMessage());
                return;
              case "stopped":
                getAnalytics().captureError(event.error, {
                  fingerprintKey: "useFolioCollaborationRoom.room:stopped",
                  scope: {
                    type: "handler",
                    handlerId: "useFolioCollaborationRoom.room:stopped",
                  },
                });
                connectedProvider.disconnect();
                setState({
                  status: "unavailable",
                  room: null,
                  message: getEditOpenFailedMessage(),
                });
                return;
              default: {
                event satisfies never;
                panic("Unhandled collaboration room event");
              }
            }
          },
        };
        const flushSnapshot = async () => {
          await whenLocalEditsSequenced();
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
          awareness,
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
          setRoomConnected(true);
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
    getEditRefusedMessage,
    getEditPermissionDeniedMessage,
    getSnapshotRecoveryMessage,
    propertyId,
    workspaceId,
  ]);

  return state;
};
