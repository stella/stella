import { HocuspocusProvider } from "@hocuspocus/provider";
import { describe, expect, test } from "bun:test";
import { applyUpdate, Doc } from "yjs";

import {
  FOLIO_COLLAB_GENERATION_RETRY_CLOSE_CODE,
  FOLIO_COLLAB_FLUSH_REQUEST_TYPE,
  FOLIO_COLLAB_FLUSH_RESPONSE_TYPE,
  FOLIO_COLLAB_REDIS_RETRY_CLOSE_CODE,
} from "@stll/api-contract/folio-collab";

import { createCollabServer } from "./server";

type FakeStellaApiOptions = {
  additionalRoomIds?: string[];
  canEdit?: boolean;
  generation?: number;
  holdFirstStore?: boolean;
  initialSnapshotBase64?: string | null;
  refreshedToken?: string;
  replacementToken?: string;
  roomId?: string;
  token?: string;
  tokenExpiresAt?: string;
};

type FakeStellaApi = {
  authorizeRequests: () => number;
  authorizeRequestBodies: () => Record<string, unknown>[];
  destroy: () => Promise<void>;
  heartbeatRequestBodies: () => Record<string, unknown>[];
  latestSnapshotBase64: () => string | null;
  latestSnapshotRevision: () => number;
  loadRequestBodies: () => Record<string, unknown>[];
  refreshRequests: () => number;
  releaseFirstStore: () => void;
  setGeneration: (generation: number) => void;
  snapshotAuthorizationHeaders: () => (string | null)[];
  storeRequestBodies: () => Record<string, unknown>[];
  storeRequests: () => number;
  url: string;
};

type AwarenessUserState = {
  user: {
    id: string;
    image: string | null;
    name: string;
  };
};

type RedisBackedCollabProcess = {
  destroy: () => Promise<void>;
  httpUrl: string;
  redisExtensionFirst: boolean;
  websocketUrl: string;
};

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 3000,
) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await Bun.sleep(10);
  }

  throw new Error(message);
};

const requestBody = async (request: Request) => {
  const value = await request.json();
  if (typeof value !== "object" || value === null) {
    return {};
  }

  return Object.fromEntries(Object.entries(value));
};

const hasAwarenessUserName = (
  state: Record<string | number, unknown>,
  name: string,
): state is AwarenessUserState =>
  typeof state["user"] === "object" &&
  state["user"] !== null &&
  "id" in state["user"] &&
  "image" in state["user"] &&
  "name" in state["user"] &&
  typeof state["user"].id === "string" &&
  (state["user"].image === null || typeof state["user"].image === "string") &&
  state["user"].name === name;

const getTextContent = (doc: Doc, name: string) => doc.getText(name).toJSON();

const farFutureTokenExpiresAt = () =>
  new Date(Date.now() + 60 * 60 * 1000).toISOString();

const TEST_ROOM_ID = "00000000-0000-4000-8000-000000000001";
const TEST_ROOM_NAME = `{${TEST_ROOM_ID}}`;
const SECOND_TEST_ROOM_ID = "00000000-0000-4000-8000-000000000002";
const SECOND_TEST_ROOM_NAME = `{${SECOND_TEST_ROOM_ID}}`;
const TEST_SERVICE_TOKEN = "test_collaboration_service_token_32_chars";
const DOCKER_OPERATION_TIMEOUT_MS = 10_000;

const createFakeStellaApi = ({
  additionalRoomIds = [],
  canEdit = true,
  generation = 0,
  holdFirstStore = false,
  initialSnapshotBase64 = null,
  refreshedToken = "collab_token_refreshed",
  replacementToken,
  roomId = TEST_ROOM_ID,
  token = "collab_token_test",
  tokenExpiresAt = farFutureTokenExpiresAt(),
}: FakeStellaApiOptions = {}): FakeStellaApi => {
  const roomGenerations = new Map(
    [roomId, ...additionalRoomIds].map((acceptedRoomId) => [
      acceptedRoomId,
      generation,
    ]),
  );
  let authorizeRequests = 0;
  const authorizeRequestBodies: Record<string, unknown>[] = [];
  const heartbeatRequestBodies: Record<string, unknown>[] = [];
  const loadRequestBodies: Record<string, unknown>[] = [];
  let latestSnapshotBase64 = initialSnapshotBase64;
  let latestSnapshotRevision = initialSnapshotBase64 === null ? 0 : 1;
  let refreshRequests = 0;
  const snapshotAuthorizationHeaders: (string | null)[] = [];
  const storeRequestBodies: Record<string, unknown>[] = [];
  let storeRequests = 0;
  let currentToken = token;
  const tokenGeneration = generation;
  const firstStoreGate = Promise.withResolvers<undefined>();
  let firstStoreHeld = holdFirstStore;

  const server = Bun.serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = await requestBody(request);

      if (url.pathname === "/v1/folio-collab-rooms/authorize") {
        authorizeRequests += 1;
        authorizeRequestBodies.push(body);
        const requestToken = body["token"];
        const requestedRoomName = body["roomName"];
        const requestedRoomId = [...roomGenerations.keys()].find(
          (acceptedRoomId) => `{${acceptedRoomId}}` === requestedRoomName,
        );
        const tokenAuthorized =
          requestToken === token ||
          (replacementToken !== undefined && requestToken === replacementToken);

        if (
          requestedRoomId === undefined ||
          !tokenAuthorized ||
          tokenGeneration !== roomGenerations.get(requestedRoomId)
        ) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        if (
          replacementToken !== undefined &&
          requestToken === replacementToken
        ) {
          currentToken = replacementToken;
        }

        return Response.json({
          canEdit,
          generation: roomGenerations.get(requestedRoomId),
          roomId: requestedRoomId,
          roomName: requestedRoomName,
          tokenExpiresAt,
          userId: "user_test",
          userName: "Authorized user",
        });
      }

      if (url.pathname === "/v1/folio-collab-rooms/refresh-token") {
        refreshRequests += 1;

        if (
          !roomGenerations.has(String(body["roomId"])) ||
          body["token"] !== currentToken ||
          tokenGeneration !== roomGenerations.get(String(body["roomId"]))
        ) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        currentToken = refreshedToken;
        return Response.json({
          canEdit,
          generation: roomGenerations.get(String(body["roomId"])),
          token: refreshedToken,
          tokenExpiresAt: farFutureTokenExpiresAt(),
        });
      }

      if (url.pathname === "/v1/folio-collab-rooms/heartbeat") {
        heartbeatRequestBodies.push(body);
        if (
          !roomGenerations.has(String(body["roomId"])) ||
          body["token"] !== currentToken
        ) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        return Response.json({ activeAt: new Date().toISOString() });
      }

      if (url.pathname === "/v1/folio-collab-rooms/snapshot/load") {
        loadRequestBodies.push(body);
        snapshotAuthorizationHeaders.push(request.headers.get("authorization"));
        if (
          !roomGenerations.has(String(body["roomId"])) ||
          request.headers.get("authorization") !==
            `Bearer ${TEST_SERVICE_TOKEN}`
        ) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        return Response.json({
          generation: roomGenerations.get(String(body["roomId"])),
          snapshotBase64: latestSnapshotBase64,
          snapshotRevision: latestSnapshotRevision,
        });
      }

      if (url.pathname === "/v1/folio-collab-rooms/snapshot/store") {
        storeRequestBodies.push(body);
        snapshotAuthorizationHeaders.push(request.headers.get("authorization"));
        if (
          !roomGenerations.has(String(body["roomId"])) ||
          request.headers.get("authorization") !==
            `Bearer ${TEST_SERVICE_TOKEN}`
        ) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        const currentGeneration = roomGenerations.get(String(body["roomId"]));
        if (body["expectedGeneration"] !== currentGeneration) {
          return Response.json(
            { message: "Snapshot generation changed." },
            { status: 409 },
          );
        }

        storeRequests += 1;
        if (firstStoreHeld) {
          firstStoreHeld = false;
          await firstStoreGate.promise;
        }
        if (body["expectedSnapshotRevision"] !== latestSnapshotRevision) {
          return Response.json(
            { message: "Snapshot revision changed." },
            { status: 428 },
          );
        }
        latestSnapshotBase64 =
          typeof body["snapshotBase64"] === "string"
            ? body["snapshotBase64"]
            : null;
        latestSnapshotRevision += 1;

        return Response.json({
          generation: currentGeneration,
          snapshotRevision: latestSnapshotRevision,
          storedAt: new Date().toISOString(),
        });
      }

      return Response.json({ message: "Not found" }, { status: 404 });
    },
    port: 0,
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("Fake stella API did not expose a listening port.");
  }

  return {
    authorizeRequests: () => authorizeRequests,
    authorizeRequestBodies: () => authorizeRequestBodies,
    destroy: async () => {
      firstStoreGate.resolve(undefined);
      await server.stop(true);
    },
    heartbeatRequestBodies: () => heartbeatRequestBodies,
    latestSnapshotBase64: () => latestSnapshotBase64,
    latestSnapshotRevision: () => latestSnapshotRevision,
    loadRequestBodies: () => loadRequestBodies,
    refreshRequests: () => refreshRequests,
    releaseFirstStore: () => firstStoreGate.resolve(undefined),
    setGeneration: (nextGeneration) => {
      roomGenerations.set(roomId, nextGeneration);
    },
    snapshotAuthorizationHeaders: () => snapshotAuthorizationHeaders,
    storeRequestBodies: () => storeRequestBodies,
    storeRequests: () => storeRequests,
    url: `http://127.0.0.1:${port}`,
  };
};

const createProvider = ({
  name,
  onClose,
  onStateless,
  token,
  url,
  ydoc,
}: {
  name: string;
  onClose?: (code: number) => void;
  onStateless?: (payload: string) => void;
  token: string;
  url: string;
  ydoc: Doc;
}) =>
  new HocuspocusProvider({
    document: ydoc,
    name,
    onClose: ({ event }) => onClose?.(event.code),
    onStateless: ({ payload }) => onStateless?.(payload),
    token,
    url,
  });

const redisTestUrl = process.env["STELLA_COLLAB_TEST_REDIS_URL"];
const redisContainerId = process.env["STELLA_COLLAB_TEST_REDIS_CONTAINER_ID"];

const requireRedisTestUrl = () => {
  if (redisTestUrl === undefined) {
    throw new Error("STELLA_COLLAB_TEST_REDIS_URL is required.");
  }

  return redisTestUrl;
};

const runDocker = async (action: "start" | "stop", containerId: string) => {
  const dockerProcess = Bun.spawn(["docker", action, containerId], {
    stderr: "pipe",
    stdout: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exitCode = await Promise.race([
    dockerProcess.exited,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        dockerProcess.kill();
        reject(
          new Error(
            `docker ${action} exceeded ${DOCKER_OPERATION_TIMEOUT_MS} ms`,
          ),
        );
      }, DOCKER_OPERATION_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
  const stderr = await new Response(dockerProcess.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`docker ${action} failed: ${stderr}`);
  }
};

const spawnRedisBackedCollabProcess = async ({
  apiUrl,
  redisUrl,
}: {
  apiUrl: string;
  redisUrl: string;
}): Promise<RedisBackedCollabProcess> => {
  const subprocess = Bun.spawn(["bun", "server-test-process.ts"], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      NODE_ENV: "test",
      STELLA_API_URL: apiUrl,
      STELLA_COLLAB_MODE: "redis",
      STELLA_COLLAB_REDIS_URL: redisUrl,
      STELLA_COLLAB_SERVICE_TOKEN: TEST_SERVICE_TOKEN,
    },
    stderr: "inherit",
    stdout: "pipe",
  });
  let outputBuffer = "";
  const startup = Promise.withResolvers<{
    port: number;
    redisExtensionFirst: boolean;
  }>();
  const outputDone = (async () => {
    const decoder = new TextDecoder();
    const reader = subprocess.stdout.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return;
      }

      outputBuffer += decoder.decode(chunk.value, { stream: true });
      let newlineIndex = outputBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = outputBuffer.slice(0, newlineIndex);
        outputBuffer = outputBuffer.slice(newlineIndex + 1);
        newlineIndex = outputBuffer.indexOf("\n");
        if (!line.startsWith("STELLA_COLLAB_TEST_READY ")) {
          continue;
        }

        const fields = line.split(" ");
        const parsedPort = Number(fields.at(1));
        if (!Number.isInteger(parsedPort) || parsedPort < 1) {
          continue;
        }
        startup.resolve({
          port: parsedPort,
          redisExtensionFirst: fields.at(2) === "true",
        });
      }
    }
  })();

  const startupTimeout = setTimeout(() => {
    startup.reject(
      new Error("Collaboration child process did not report its port."),
    );
  }, 10_000);
  const started = await (async () => {
    try {
      return await Promise.race([
        startup.promise,
        subprocess.exited.then(() => {
          throw new Error("Collaboration child process exited before startup.");
        }),
      ]);
    } catch (error) {
      if (subprocess.exitCode === null) {
        subprocess.kill();
      }
      await subprocess.exited;
      await outputDone;
      throw error;
    } finally {
      clearTimeout(startupTimeout);
    }
  })();

  return {
    destroy: async () => {
      if (subprocess.exitCode === null) {
        subprocess.kill();
      }
      await subprocess.exited;
      await outputDone;
    },
    httpUrl: `http://127.0.0.1:${String(started.port)}`,
    redisExtensionFirst: started.redisExtensionFirst,
    websocketUrl: `ws://127.0.0.1:${String(started.port)}`,
  };
};

const spawnRedisBackedCollabProcesses = async (options: {
  apiUrl: string;
  redisUrl: string;
}) => {
  const first = await spawnRedisBackedCollabProcess(options);
  try {
    const second = await spawnRedisBackedCollabProcess(options);
    return { first, second };
  } catch (error) {
    await first.destroy();
    throw error;
  }
};

const readinessStatus = async (server: RedisBackedCollabProcess) =>
  (await fetch(`${server.httpUrl}/readyz`)).status;

describe("collaboration server", () => {
  test("serves HTTP health and accepts a Bun WebSocket upgrade", async () => {
    const fakeApi = createFakeStellaApi();
    const collabServer = await createCollabServer({
      apiUrl: fakeApi.url,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
    });

    try {
      const response = await fetch(collabServer.httpUrl);
      expect(await response.text()).toBe("Welcome to Hocuspocus!");
      expect((await fetch(`${collabServer.httpUrl}/readyz`)).status).toBe(200);

      await new Promise<void>((resolve, reject) => {
        const websocket = new WebSocket(collabServer.websocketUrl);
        const timeout = setTimeout(() => {
          reject(new Error("WebSocket did not open."));
        }, 1000);

        websocket.addEventListener("open", () => {
          clearTimeout(timeout);
          websocket.close();
          resolve();
        });
        websocket.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket failed to open."));
        });
      });
    } finally {
      await collabServer.destroy();
      await fakeApi.destroy();
    }
  });

  test("syncs Yjs document updates and awareness between two clients", async () => {
    const fakeApi = createFakeStellaApi();
    const collabServer = await createCollabServer({
      apiUrl: fakeApi.url,
      debounceMs: 20,
      maxDebounceMs: 100,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
    });

    const firstDoc = new Doc();
    const secondDoc = new Doc();
    const firstProvider = createProvider({
      name: TEST_ROOM_NAME,
      token: "collab_token_test",
      url: collabServer.websocketUrl,
      ydoc: firstDoc,
    });
    const secondProvider = createProvider({
      name: TEST_ROOM_NAME,
      token: "collab_token_test",
      url: collabServer.websocketUrl,
      ydoc: secondDoc,
    });

    try {
      await waitFor(
        () => firstProvider.isAuthenticated && secondProvider.isAuthenticated,
        "Providers did not authenticate.",
      );

      expect(fakeApi.authorizeRequestBodies()).toEqual([
        { roomName: TEST_ROOM_NAME, token: "collab_token_test" },
        { roomName: TEST_ROOM_NAME, token: "collab_token_test" },
      ]);
      expect(fakeApi.heartbeatRequestBodies()).toEqual([
        { roomId: TEST_ROOM_ID, token: "collab_token_test" },
      ]);
      await waitFor(
        () => fakeApi.loadRequestBodies().length === 1,
        "Server did not load the room snapshot.",
      );
      expect(fakeApi.loadRequestBodies()).toEqual([{ roomId: TEST_ROOM_ID }]);

      firstProvider.awareness?.setLocalStateField("user", {
        color: "#000000",
        id: "impersonated_user",
        image: "https://attacker.invalid/avatar.png",
        name: "First user",
      });

      await waitFor(
        () =>
          Array.from(secondProvider.awareness?.getStates().values() ?? []).some(
            (state) => hasAwarenessUserName(state, "Authorized user"),
          ),
        "Awareness state did not reach the second provider.",
      );
      const authorizedPresence = Array.from(
        secondProvider.awareness?.getStates().values() ?? [],
      ).find((state) => hasAwarenessUserName(state, "Authorized user"));
      expect(authorizedPresence?.user).toMatchObject({
        id: "user_test",
        image: null,
        name: "Authorized user",
      });

      firstDoc.getText("body").insert(0, "hello collaborative folio");

      await waitFor(
        () => getTextContent(secondDoc, "body") === "hello collaborative folio",
        "Document update did not sync to the second provider.",
      );

      await waitFor(
        () => fakeApi.storeRequests() > 0,
        "Server did not persist a Yjs snapshot.",
      );

      const snapshotBase64 = fakeApi.latestSnapshotBase64();
      expect(snapshotBase64).not.toBeNull();

      const restoredDoc = new Doc();
      applyUpdate(restoredDoc, Buffer.from(snapshotBase64 ?? "", "base64"));
      expect(getTextContent(restoredDoc, "body")).toBe(
        "hello collaborative folio",
      );
      expect(fakeApi.storeRequestBodies()[0]).toMatchObject({
        expectedGeneration: 0,
        roomId: TEST_ROOM_ID,
      });
      expect(fakeApi.snapshotAuthorizationHeaders()).toEqual([
        `Bearer ${TEST_SERVICE_TOKEN}`,
        `Bearer ${TEST_SERVICE_TOKEN}`,
      ]);
      expect(fakeApi.authorizeRequests()).toBeGreaterThanOrEqual(2);
    } finally {
      firstProvider.destroy();
      secondProvider.destroy();
      firstDoc.destroy();
      secondDoc.destroy();
      await collabServer.destroy();
      await fakeApi.destroy();
    }
  });

  test("acknowledges a publication flush only after storing the current cut", async () => {
    const fakeApi = createFakeStellaApi();
    const collabServer = await createCollabServer({
      apiUrl: fakeApi.url,
      debounceMs: 10_000,
      maxDebounceMs: 10_000,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
    });
    const document = new Doc();
    const requestId = "00000000-0000-4000-8000-000000000099";
    let acknowledged = false;
    const provider = createProvider({
      name: TEST_ROOM_NAME,
      onStateless: (payload) => {
        if (
          payload ===
          JSON.stringify({
            requestId,
            snapshotRevision: 1,
            type: FOLIO_COLLAB_FLUSH_RESPONSE_TYPE,
          })
        ) {
          acknowledged = true;
        }
      },
      token: "collab_token_test",
      url: collabServer.websocketUrl,
      ydoc: document,
    });

    try {
      await waitFor(
        () => provider.isAuthenticated,
        "Provider did not authenticate.",
      );
      document.getText("body").insert(0, "publish this cut");
      provider.flushPendingUpdates();
      provider.sendStateless(
        JSON.stringify({
          requestId,
          type: FOLIO_COLLAB_FLUSH_REQUEST_TYPE,
        }),
      );
      await waitFor(
        () => acknowledged,
        "Collaboration server did not acknowledge the flush.",
      );
      expect(fakeApi.storeRequests()).toBe(1);
      const snapshotBase64 = fakeApi.latestSnapshotBase64();
      const restored = new Doc();
      applyUpdate(restored, Buffer.from(snapshotBase64 ?? "", "base64"));
      expect(getTextContent(restored, "body")).toBe("publish this cut");
      restored.destroy();
    } finally {
      provider.destroy();
      document.destroy();
      await collabServer.destroy();
      await fakeApi.destroy();
    }
  });

  test("serializes overlapping stores before acknowledging the latest cut", async () => {
    const fakeApi = createFakeStellaApi({ holdFirstStore: true });
    const collabServer = await createCollabServer({
      apiUrl: fakeApi.url,
      debounceMs: 10_000,
      maxDebounceMs: 10_000,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
    });
    const document = new Doc();
    const firstRequestId = "00000000-0000-4000-8000-000000000091";
    const secondRequestId = "00000000-0000-4000-8000-000000000092";
    const acknowledgements = new Set<string>();
    const provider = createProvider({
      name: TEST_ROOM_NAME,
      onStateless: (payload) => {
        const parsed: unknown = JSON.parse(payload);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "requestId" in parsed &&
          typeof parsed.requestId === "string"
        ) {
          acknowledgements.add(parsed.requestId);
        }
      },
      token: "collab_token_test",
      url: collabServer.websocketUrl,
      ydoc: document,
    });

    try {
      await waitFor(
        () => provider.isAuthenticated,
        "Provider did not authenticate.",
      );
      document.getText("body").insert(0, "first");
      provider.flushPendingUpdates();
      provider.sendStateless(
        JSON.stringify({
          requestId: firstRequestId,
          type: FOLIO_COLLAB_FLUSH_REQUEST_TYPE,
        }),
      );
      await waitFor(
        () => fakeApi.storeRequests() === 1,
        "First snapshot store did not start.",
      );

      document.getText("body").insert(5, " second");
      provider.flushPendingUpdates();
      provider.sendStateless(
        JSON.stringify({
          requestId: secondRequestId,
          type: FOLIO_COLLAB_FLUSH_REQUEST_TYPE,
        }),
      );
      await Bun.sleep(50);
      expect(fakeApi.storeRequests()).toBe(1);

      fakeApi.releaseFirstStore();
      await waitFor(
        () => fakeApi.storeRequests() === 2 && acknowledgements.size === 2,
        "Queued snapshot store did not finish.",
      );

      const restored = new Doc();
      applyUpdate(
        restored,
        Buffer.from(fakeApi.latestSnapshotBase64() ?? "", "base64"),
      );
      expect(getTextContent(restored, "body")).toBe("first second");
      restored.destroy();
    } finally {
      fakeApi.releaseFirstStore();
      provider.destroy();
      document.destroy();
      await collabServer.destroy();
      await fakeApi.destroy();
    }
  });

  test("merges and retries when another replica advances the durable snapshot", async () => {
    const fakeApi = createFakeStellaApi({ holdFirstStore: true });
    const firstServer = await createCollabServer({
      apiUrl: fakeApi.url,
      debounceMs: 10_000,
      maxDebounceMs: 10_000,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
    });
    const secondServer = await createCollabServer({
      apiUrl: fakeApi.url,
      debounceMs: 10_000,
      maxDebounceMs: 10_000,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
    });
    const firstDocument = new Doc();
    const secondDocument = new Doc();
    const acknowledgements = new Set<string>();
    const firstRequestId = "00000000-0000-4000-8000-000000000093";
    const secondRequestId = "00000000-0000-4000-8000-000000000094";
    const recordAcknowledgement = (payload: string) => {
      const parsed: unknown = JSON.parse(payload);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "requestId" in parsed &&
        typeof parsed.requestId === "string"
      ) {
        acknowledgements.add(parsed.requestId);
      }
    };
    const firstProvider = createProvider({
      name: TEST_ROOM_NAME,
      onStateless: recordAcknowledgement,
      token: "collab_token_test",
      url: firstServer.websocketUrl,
      ydoc: firstDocument,
    });
    const secondProvider = createProvider({
      name: TEST_ROOM_NAME,
      onStateless: recordAcknowledgement,
      token: "collab_token_test",
      url: secondServer.websocketUrl,
      ydoc: secondDocument,
    });

    try {
      await waitFor(
        () => firstProvider.isAuthenticated && secondProvider.isAuthenticated,
        "Providers did not authenticate across replicas.",
      );
      firstDocument.getText("firstReplica").insert(0, "first");
      firstProvider.flushPendingUpdates();
      firstProvider.sendStateless(
        JSON.stringify({
          requestId: firstRequestId,
          type: FOLIO_COLLAB_FLUSH_REQUEST_TYPE,
        }),
      );
      await waitFor(
        () => fakeApi.storeRequestBodies().length === 1,
        "First replica snapshot store did not start.",
      );

      secondDocument.getText("secondReplica").insert(0, "second");
      secondProvider.flushPendingUpdates();
      secondProvider.sendStateless(
        JSON.stringify({
          requestId: secondRequestId,
          type: FOLIO_COLLAB_FLUSH_REQUEST_TYPE,
        }),
      );
      await waitFor(
        () => acknowledgements.has(secondRequestId),
        "Second replica snapshot was not acknowledged.",
      );

      fakeApi.releaseFirstStore();
      await waitFor(
        () => acknowledgements.has(firstRequestId),
        "Stale first replica did not merge and retry.",
      );

      expect(fakeApi.latestSnapshotRevision()).toBe(2);
      expect(
        fakeApi
          .storeRequestBodies()
          .map((body) => body["expectedSnapshotRevision"]),
      ).toEqual([0, 0, 1]);
      const restored = new Doc();
      applyUpdate(
        restored,
        Buffer.from(fakeApi.latestSnapshotBase64() ?? "", "base64"),
      );
      expect(getTextContent(restored, "firstReplica")).toBe("first");
      expect(getTextContent(restored, "secondReplica")).toBe("second");
      restored.destroy();
    } finally {
      fakeApi.releaseFirstStore();
      firstProvider.destroy();
      secondProvider.destroy();
      firstDocument.destroy();
      secondDocument.destroy();
      await firstServer.destroy();
      await secondServer.destroy();
      await fakeApi.destroy();
    }
  }, 15_000);

  test("rejects a stale snapshot generation without publishing old room state", async () => {
    const fakeApi = createFakeStellaApi({
      additionalRoomIds: [SECOND_TEST_ROOM_ID],
    });
    const collabServer = await createCollabServer({
      apiUrl: fakeApi.url,
      debounceMs: 20,
      maxDebounceMs: 100,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
      shutdownDrainTimeoutMs: 25,
    });
    const ydoc = new Doc();
    const closeCodes: number[] = [];
    const secondRoomCloseCodes: number[] = [];
    const provider = createProvider({
      name: TEST_ROOM_NAME,
      onClose: (code) => {
        closeCodes.push(code);
      },
      token: "collab_token_test",
      url: collabServer.websocketUrl,
      ydoc,
    });
    const secondRoomDoc = new Doc();
    const secondRoomProvider = createProvider({
      name: SECOND_TEST_ROOM_NAME,
      onClose: (code) => {
        secondRoomCloseCodes.push(code);
      },
      token: "collab_token_test",
      url: collabServer.websocketUrl,
      ydoc: secondRoomDoc,
    });

    try {
      await waitFor(
        () =>
          provider.isAuthenticated &&
          secondRoomProvider.isAuthenticated &&
          fakeApi.loadRequestBodies().length >= 2,
        "Providers did not load their initial room generations.",
      );
      fakeApi.setGeneration(1);

      ydoc.getText("body").insert(0, "must remain local");

      await waitFor(
        () => fakeApi.storeRequestBodies().length > 0,
        "Server did not reject the stale room generation.",
      );
      await Bun.sleep(100);
      expect(closeCodes).toContain(FOLIO_COLLAB_GENERATION_RETRY_CLOSE_CODE);
      expect(closeCodes).not.toContain(FOLIO_COLLAB_REDIS_RETRY_CLOSE_CODE);
      expect(secondRoomCloseCodes).not.toContain(
        FOLIO_COLLAB_GENERATION_RETRY_CLOSE_CODE,
      );
      expect(secondRoomProvider.isAuthenticated).toBeTrue();
      provider.destroy();
      await Bun.sleep(100);
      expect(fakeApi.storeRequests()).toBe(0);
      expect(fakeApi.latestSnapshotBase64()).toBeNull();
      for (const body of fakeApi.storeRequestBodies()) {
        expect(body).toMatchObject({
          expectedGeneration: 0,
          roomId: TEST_ROOM_ID,
        });
      }
      expect(
        fakeApi
          .loadRequestBodies()
          .filter((body) => body["roomId"] === TEST_ROOM_ID),
      ).toHaveLength(1);
    } finally {
      provider.destroy();
      secondRoomProvider.destroy();
      ydoc.destroy();
      secondRoomDoc.destroy();
      await collabServer.destroy();
      await fakeApi.destroy();
    }
  });

  test("bounds shutdown when a document cannot unload", async () => {
    const fakeApi = createFakeStellaApi();
    const collabServer = await createCollabServer({
      apiUrl: fakeApi.url,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
      shutdownDrainTimeoutMs: 25,
    });
    const ydoc = new Doc();
    const provider = createProvider({
      name: TEST_ROOM_NAME,
      token: "collab_token_test",
      url: collabServer.websocketUrl,
      ydoc,
    });
    let destroyed = false;

    try {
      await waitFor(
        () =>
          provider.isAuthenticated &&
          fakeApi.loadRequestBodies().length === 1 &&
          collabServer.hocuspocus.getDocumentsCount() === 1,
        "Provider did not load a document before shutdown.",
      );
      const neverUnload = new Promise<void>(() => {
        // This test models a buggy extension that never completes its hook.
      });
      collabServer.hocuspocus.configuration.extensions.push({
        beforeUnloadDocument: async () => {
          await neverUnload;
        },
      });

      const startedAt = Date.now();
      await collabServer.destroy();
      destroyed = true;

      expect(Date.now() - startedAt).toBeLessThan(1000);
    } finally {
      provider.destroy();
      ydoc.destroy();
      if (!destroyed) {
        await collabServer.destroy();
      }
      await fakeApi.destroy();
    }
  });

  test("refreshes the stella API token before storing snapshots", async () => {
    const initialToken = "collab_token_initial";
    const refreshedToken = "collab_token_refreshed";
    const fakeApi = createFakeStellaApi({
      refreshedToken,
      token: initialToken,
      tokenExpiresAt: new Date(Date.now() + 50).toISOString(),
    });
    const collabServer = await createCollabServer({
      apiUrl: fakeApi.url,
      debounceMs: 20,
      maxDebounceMs: 100,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
    });

    const ydoc = new Doc();
    const provider = createProvider({
      name: TEST_ROOM_NAME,
      token: initialToken,
      url: collabServer.websocketUrl,
      ydoc,
    });

    try {
      await waitFor(
        () => provider.isAuthenticated,
        "Provider did not authenticate.",
      );
      await waitFor(
        () => fakeApi.refreshRequests() > 0,
        "Server did not refresh the token before expiry.",
      );

      ydoc.getText("body").insert(0, "stored with refreshed token");

      await waitFor(
        () => fakeApi.storeRequests() > 0,
        "Server did not persist a snapshot after refreshing.",
      );

      expect(fakeApi.storeRequestBodies()[0]).toMatchObject({
        expectedGeneration: 0,
        roomId: TEST_ROOM_ID,
      });
      expect(fakeApi.snapshotAuthorizationHeaders()).toContain(
        `Bearer ${TEST_SERVICE_TOKEN}`,
      );
    } finally {
      provider.destroy();
      ydoc.destroy();
      await collabServer.destroy();
      await fakeApi.destroy();
    }
  });

  test("replaces a cached room token when a new token has the same expiry", async () => {
    const initialToken = "collab_token_initial";
    const replacementToken = "collab_token_replacement";
    const fakeApi = createFakeStellaApi({
      replacementToken,
      token: initialToken,
      tokenExpiresAt: farFutureTokenExpiresAt(),
    });
    const collabServer = await createCollabServer({
      apiUrl: fakeApi.url,
      debounceMs: 20,
      maxDebounceMs: 100,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
    });

    const firstDoc = new Doc();
    const secondDoc = new Doc();
    const firstProvider = createProvider({
      name: TEST_ROOM_NAME,
      token: initialToken,
      url: collabServer.websocketUrl,
      ydoc: firstDoc,
    });

    try {
      await waitFor(
        () => firstProvider.isAuthenticated,
        "First provider did not authenticate.",
      );

      const secondProvider = createProvider({
        name: TEST_ROOM_NAME,
        token: replacementToken,
        url: collabServer.websocketUrl,
        ydoc: secondDoc,
      });

      try {
        await waitFor(
          () => secondProvider.isAuthenticated,
          "Second provider did not authenticate.",
        );

        secondDoc.getText("body").insert(0, "stored with replacement token");

        await waitFor(
          () => fakeApi.storeRequests() > 0,
          "Server did not persist a snapshot with the replacement token.",
        );

        expect(fakeApi.snapshotAuthorizationHeaders()).toContain(
          `Bearer ${TEST_SERVICE_TOKEN}`,
        );
      } finally {
        secondProvider.destroy();
      }
    } finally {
      firstProvider.destroy();
      firstDoc.destroy();
      secondDoc.destroy();
      await collabServer.destroy();
      await fakeApi.destroy();
    }
  });

  test("does not persist snapshots for read-only sessions", async () => {
    const fakeApi = createFakeStellaApi({ canEdit: false });
    const collabServer = await createCollabServer({
      apiUrl: fakeApi.url,
      debounceMs: 20,
      maxDebounceMs: 100,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
    });

    const ydoc = new Doc();
    const provider = createProvider({
      name: TEST_ROOM_NAME,
      token: "collab_token_test",
      url: collabServer.websocketUrl,
      ydoc,
    });

    try {
      await waitFor(
        () => provider.isAuthenticated,
        "Provider did not authenticate.",
      );

      ydoc.getText("body").insert(0, "read-only local edit");
      await Bun.sleep(150);

      expect(fakeApi.storeRequests()).toBe(0);
    } finally {
      provider.destroy();
      ydoc.destroy();
      await collabServer.destroy();
      await fakeApi.destroy();
    }
  });

  test("rejects clients when stella API authorization fails", async () => {
    const fakeApi = createFakeStellaApi();
    const collabServer = await createCollabServer({
      apiUrl: fakeApi.url,
      debounceMs: 20,
      maxDebounceMs: 100,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
    });
    const ydoc = new Doc();
    let authenticationFailed = false;
    let provider: HocuspocusProvider | undefined;

    try {
      provider = new HocuspocusProvider({
        document: ydoc,
        name: TEST_ROOM_NAME,
        onAuthenticationFailed: () => {
          authenticationFailed = true;
        },
        token: "wrong_token",
        url: collabServer.websocketUrl,
      });

      await waitFor(
        () => authenticationFailed,
        "Provider was not rejected after failed authorization.",
      );

      expect(provider.isAuthenticated).toBe(false);
    } finally {
      provider?.destroy();
      ydoc.destroy();
      await collabServer.destroy();
      await fakeApi.destroy();
    }
  });

  test("does not forward room tokens through API redirects", async () => {
    let redirectedRequests = 0;
    const redirectTarget = Bun.serve({
      fetch: () => {
        redirectedRequests += 1;
        return Response.json({ message: "Redirect target reached." });
      },
      port: 0,
    });
    const redirectTargetPort = redirectTarget.port;
    if (redirectTargetPort === undefined) {
      throw new Error("Redirect target did not expose a listening port.");
    }

    const redirectingApi = Bun.serve({
      fetch: () =>
        Response.redirect(
          `http://127.0.0.1:${String(redirectTargetPort)}/token-target`,
          307,
        ),
      port: 0,
    });
    const redirectingApiPort = redirectingApi.port;
    if (redirectingApiPort === undefined) {
      throw new Error("Redirecting API did not expose a listening port.");
    }

    const collabServer = await createCollabServer({
      apiUrl: `http://127.0.0.1:${String(redirectingApiPort)}`,
      port: 0,
      serviceToken: TEST_SERVICE_TOKEN,
    });
    const ydoc = new Doc();
    let authenticationFailed = false;
    const provider = new HocuspocusProvider({
      document: ydoc,
      name: TEST_ROOM_NAME,
      onAuthenticationFailed: () => {
        authenticationFailed = true;
      },
      token: "collab_token_redirect_test",
      url: collabServer.websocketUrl,
    });

    try {
      await waitFor(
        () => authenticationFailed,
        "Provider was not rejected after the API redirect.",
      );
      expect(redirectedRequests).toBe(0);
    } finally {
      provider.destroy();
      ydoc.destroy();
      await collabServer.destroy();
      await redirectingApi.stop(true);
      await redirectTarget.stop(true);
    }
  });
});

describe.skipIf(redisTestUrl === undefined)(
  "Redis-backed collaboration server",
  () => {
    test("converges document and awareness updates across two replicas", async () => {
      const redisUrl = requireRedisTestUrl();
      const fakeApi = createFakeStellaApi();
      const { first: firstServer, second: secondServer } =
        await spawnRedisBackedCollabProcesses({
          apiUrl: fakeApi.url,
          redisUrl,
        });
      const firstDoc = new Doc();
      const secondDoc = new Doc();
      const lateDoc = new Doc();
      const firstCloseCodes: number[] = [];
      const secondCloseCodes: number[] = [];
      const firstProvider = createProvider({
        name: TEST_ROOM_NAME,
        onClose: (code) => {
          firstCloseCodes.push(code);
        },
        token: "collab_token_test",
        url: firstServer.websocketUrl,
        ydoc: firstDoc,
      });
      const secondProvider = createProvider({
        name: TEST_ROOM_NAME,
        onClose: (code) => {
          secondCloseCodes.push(code);
        },
        token: "collab_token_test",
        url: secondServer.websocketUrl,
        ydoc: secondDoc,
      });
      let lateProvider: HocuspocusProvider | undefined;
      let redisWasStopped = false;

      try {
        await waitFor(
          async () =>
            (await readinessStatus(firstServer)) === 200 &&
            (await readinessStatus(secondServer)) === 200,
          "Redis clients did not become ready.",
          10_000,
        );
        expect(firstServer.redisExtensionFirst).toBe(true);
        expect(secondServer.redisExtensionFirst).toBe(true);
        await waitFor(
          () => firstProvider.isAuthenticated && secondProvider.isAuthenticated,
          "Providers did not authenticate across replicas.",
          10_000,
        );
        await waitFor(
          () => firstProvider.isSynced && secondProvider.isSynced,
          "Providers did not finish their initial cross-replica sync.",
          10_000,
        );

        firstProvider.awareness?.setLocalStateField("user", {
          color: "#000000",
          name: "First user",
        });
        await waitFor(
          () =>
            Array.from(
              secondProvider.awareness?.getStates().values() ?? [],
            ).some((state) => hasAwarenessUserName(state, "Authorized user")),
          "Awareness did not cross the Redis boundary.",
        );

        const storesBeforeUpdate = fakeApi.storeRequests();
        firstDoc.getText("body").insert(0, "shared");
        await waitFor(
          () => getTextContent(secondDoc, "body") === "shared",
          "Document update did not cross the Redis boundary.",
        );
        await waitFor(
          () => fakeApi.storeRequests() > storesBeforeUpdate,
          "Redis-backed room was not persisted.",
        );
        await Bun.sleep(150);
        expect(fakeApi.storeRequests() - storesBeforeUpdate).toBe(1);

        firstDoc.getText("body").insert(0, "A");
        secondDoc.getText("body").insert(0, "B");
        await waitFor(
          () =>
            getTextContent(firstDoc, "body") ===
              getTextContent(secondDoc, "body") &&
            getTextContent(firstDoc, "body").length === 8,
          "Concurrent cross-replica updates did not converge.",
        );

        lateProvider = createProvider({
          name: TEST_ROOM_NAME,
          token: "collab_token_test",
          url: secondServer.websocketUrl,
          ydoc: lateDoc,
        });
        await waitFor(
          () =>
            lateProvider?.isAuthenticated === true &&
            getTextContent(lateDoc, "body") ===
              getTextContent(firstDoc, "body"),
          "Late joiner did not receive the converged room.",
          10_000,
        );

        if (redisContainerId === undefined) {
          return;
        }

        await runDocker("stop", redisContainerId);
        redisWasStopped = true;
        await waitFor(
          async () =>
            (await readinessStatus(firstServer)) === 503 &&
            (await readinessStatus(secondServer)) === 503,
          "Replicas remained ready after Redis stopped.",
          10_000,
        );
        expect((await fetch(`${firstServer.httpUrl}/readyz`)).status).toBe(503);
        expect((await fetch(`${secondServer.httpUrl}/readyz`)).status).toBe(
          503,
        );
        await waitFor(
          () =>
            firstCloseCodes.includes(FOLIO_COLLAB_REDIS_RETRY_CLOSE_CODE) &&
            secondCloseCodes.includes(FOLIO_COLLAB_REDIS_RETRY_CLOSE_CODE),
          "Replicas did not close clients with the retryable code.",
          10_000,
        );

        firstDoc.getText("body").insert(0, "offline-first-");
        secondDoc.getText("body").insert(0, "offline-second-");

        await runDocker("start", redisContainerId);
        redisWasStopped = false;
        await waitFor(
          async () =>
            (await readinessStatus(firstServer)) === 200 &&
            (await readinessStatus(secondServer)) === 200,
          "Replicas did not become ready after Redis restarted.",
          20_000,
        );
        await waitFor(
          () =>
            firstProvider.isAuthenticated &&
            secondProvider.isAuthenticated &&
            getTextContent(firstDoc, "body") ===
              getTextContent(secondDoc, "body"),
          "Providers did not reconnect with their local Yjs updates.",
          20_000,
        );
      } finally {
        if (redisWasStopped && redisContainerId !== undefined) {
          await runDocker("start", redisContainerId);
        }
        lateProvider?.destroy();
        firstProvider.destroy();
        secondProvider.destroy();
        lateDoc.destroy();
        firstDoc.destroy();
        secondDoc.destroy();
        await firstServer.destroy();
        await secondServer.destroy();
        await fakeApi.destroy();
      }
    }, 120_000);
  },
);
