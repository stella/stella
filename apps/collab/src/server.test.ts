import { HocuspocusProvider } from "@hocuspocus/provider";
import { describe, expect, test } from "bun:test";
import { applyUpdate, Doc } from "yjs";

import { createCollabServer } from "./server";

type FakeStellaApiOptions = {
  canEdit?: boolean;
  generation?: number;
  initialSnapshotBase64?: string | null;
  refreshedToken?: string;
  replacementToken?: string;
  roomName?: string;
  token?: string;
  tokenExpiresAt?: string;
};

type FakeStellaApi = {
  authorizeRequests: () => number;
  authorizeRequestBodies: () => Record<string, unknown>[];
  destroy: () => Promise<void>;
  heartbeatRequestBodies: () => Record<string, unknown>[];
  latestSnapshotBase64: () => string | null;
  loadRequestBodies: () => Record<string, unknown>[];
  refreshRequests: () => number;
  storeRequestTokens: () => string[];
  storeRequestBodies: () => Record<string, unknown>[];
  storeRequests: () => number;
  url: string;
};

type AwarenessUserState = {
  user: {
    name: string;
  };
};

const waitFor = async (
  predicate: () => boolean,
  message: string,
  timeoutMs = 3000,
) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- polling delay between predicate checks until the condition is met
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
  "name" in state["user"] &&
  state["user"].name === name;

const getTextContent = (doc: Doc, name: string) => doc.getText(name).toJSON();

const farFutureTokenExpiresAt = () =>
  new Date(Date.now() + 60 * 60 * 1000).toISOString();

const createFakeStellaApi = ({
  canEdit = true,
  generation = 0,
  initialSnapshotBase64 = null,
  refreshedToken = "collab_token_refreshed",
  replacementToken,
  roomName = "folio_collab_room_test",
  token = "collab_token_test",
  tokenExpiresAt = farFutureTokenExpiresAt(),
}: FakeStellaApiOptions = {}): FakeStellaApi => {
  let authorizeRequests = 0;
  const authorizeRequestBodies: Record<string, unknown>[] = [];
  const heartbeatRequestBodies: Record<string, unknown>[] = [];
  const loadRequestBodies: Record<string, unknown>[] = [];
  let latestSnapshotBase64 = initialSnapshotBase64;
  let refreshRequests = 0;
  const storeRequestTokens: string[] = [];
  const storeRequestBodies: Record<string, unknown>[] = [];
  let storeRequests = 0;
  let currentToken = token;

  const server = Bun.serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = await requestBody(request);

      if (url.pathname === "/v1/folio-collab-rooms/authorize") {
        authorizeRequests += 1;
        authorizeRequestBodies.push(body);
        const requestToken = body["token"];
        const tokenAuthorized =
          requestToken === token ||
          (replacementToken !== undefined && requestToken === replacementToken);

        if (body["roomId"] !== roomName || !tokenAuthorized) {
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
          generation,
          roomId: roomName,
          roomName,
          tokenExpiresAt,
          userId: "user_test",
          workspaceId: "workspace_test",
        });
      }

      if (url.pathname === "/v1/folio-collab-rooms/refresh-token") {
        refreshRequests += 1;

        if (body["roomId"] !== roomName || body["token"] !== currentToken) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        currentToken = refreshedToken;
        return Response.json({
          canEdit,
          generation,
          token: refreshedToken,
          tokenExpiresAt: farFutureTokenExpiresAt(),
        });
      }

      if (url.pathname === "/v1/folio-collab-rooms/heartbeat") {
        heartbeatRequestBodies.push(body);
        if (body["roomId"] !== roomName || body["token"] !== currentToken) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        return Response.json({ activeAt: new Date().toISOString() });
      }

      if (url.pathname === "/v1/folio-collab-rooms/snapshot/load") {
        loadRequestBodies.push(body);
        if (body["roomId"] !== roomName || body["token"] !== currentToken) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        return Response.json({
          generation,
          snapshotBase64: latestSnapshotBase64,
        });
      }

      if (url.pathname === "/v1/folio-collab-rooms/snapshot/store") {
        storeRequestBodies.push(body);
        if (body["roomId"] !== roomName || body["token"] !== currentToken) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        storeRequests += 1;
        storeRequestTokens.push(
          typeof body["token"] === "string" ? body["token"] : "",
        );
        latestSnapshotBase64 =
          typeof body["snapshotBase64"] === "string"
            ? body["snapshotBase64"]
            : null;

        return Response.json({
          generation,
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
      await server.stop(true);
    },
    heartbeatRequestBodies: () => heartbeatRequestBodies,
    latestSnapshotBase64: () => latestSnapshotBase64,
    loadRequestBodies: () => loadRequestBodies,
    refreshRequests: () => refreshRequests,
    storeRequestTokens: () => storeRequestTokens,
    storeRequestBodies: () => storeRequestBodies,
    storeRequests: () => storeRequests,
    url: `http://127.0.0.1:${port}`,
  };
};

const createProvider = ({
  name,
  token,
  url,
  ydoc,
}: {
  name: string;
  token: string;
  url: string;
  ydoc: Doc;
}) =>
  new HocuspocusProvider({
    document: ydoc,
    name,
    token,
    url,
  });

describe("collaboration server", () => {
  test("serves HTTP health and accepts a Bun WebSocket upgrade", async () => {
    const fakeApi = createFakeStellaApi();
    const collabServer = await createCollabServer({
      apiUrl: fakeApi.url,
      port: 0,
    });

    try {
      const response = await fetch(collabServer.httpUrl);
      expect(await response.text()).toBe("Welcome to Hocuspocus!");

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
    });

    const firstDoc = new Doc();
    const secondDoc = new Doc();
    const firstProvider = createProvider({
      name: "folio_collab_room_test",
      token: "collab_token_test",
      url: collabServer.websocketUrl,
      ydoc: firstDoc,
    });
    const secondProvider = createProvider({
      name: "folio_collab_room_test",
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
        { roomId: "folio_collab_room_test", token: "collab_token_test" },
        { roomId: "folio_collab_room_test", token: "collab_token_test" },
      ]);
      expect(fakeApi.heartbeatRequestBodies()).toEqual([
        { roomId: "folio_collab_room_test", token: "collab_token_test" },
        { roomId: "folio_collab_room_test", token: "collab_token_test" },
      ]);
      await waitFor(
        () => fakeApi.loadRequestBodies().length === 1,
        "Server did not load the room snapshot.",
      );
      expect(fakeApi.loadRequestBodies()).toEqual([
        { roomId: "folio_collab_room_test", token: "collab_token_test" },
      ]);

      firstProvider.awareness?.setLocalStateField("user", {
        color: "#000000",
        name: "First user",
      });

      await waitFor(
        () =>
          Array.from(secondProvider.awareness?.getStates().values() ?? []).some(
            (state) => hasAwarenessUserName(state, "First user"),
          ),
        "Awareness state did not reach the second provider.",
      );

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
        roomId: "folio_collab_room_test",
        token: "collab_token_test",
      });
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
    });

    const ydoc = new Doc();
    const provider = createProvider({
      name: "folio_collab_room_test",
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

      expect(fakeApi.storeRequestTokens()).toEqual([refreshedToken]);
      expect(fakeApi.storeRequestBodies()[0]).toMatchObject({
        expectedGeneration: 0,
        roomId: "folio_collab_room_test",
        token: refreshedToken,
      });
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
    });

    const firstDoc = new Doc();
    const secondDoc = new Doc();
    const firstProvider = createProvider({
      name: "folio_collab_room_test",
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
        name: "folio_collab_room_test",
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

        expect(fakeApi.storeRequestTokens()).toEqual([replacementToken]);
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
    });

    const ydoc = new Doc();
    const provider = createProvider({
      name: "folio_collab_room_test",
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
    });
    const ydoc = new Doc();
    let authenticationFailed = false;
    let provider: HocuspocusProvider | undefined;

    try {
      provider = new HocuspocusProvider({
        document: ydoc,
        name: "folio_collab_room_test",
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
    });
    const ydoc = new Doc();
    let authenticationFailed = false;
    const provider = new HocuspocusProvider({
      document: ydoc,
      name: "folio_collab_room_test",
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
