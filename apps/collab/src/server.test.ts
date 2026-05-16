import { HocuspocusProvider } from "@hocuspocus/provider";
import { describe, expect, test } from "bun:test";
import { applyUpdate, Doc } from "yjs";

import { createCollabServer } from "./server";

type FakeStellaApiOptions = {
  canEdit?: boolean;
  initialSnapshotBase64?: string | null;
  refreshedToken?: string;
  roomName?: string;
  token?: string;
  tokenExpiresAt?: string;
};

type FakeStellaApi = {
  authorizeRequests: () => number;
  destroy: () => Promise<void>;
  latestSnapshotBase64: () => string | null;
  refreshRequests: () => number;
  storeRequestTokens: () => string[];
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

    await Bun.sleep(10);
  }

  throw new Error(message);
};

const bodyString = async (request: Request) => {
  const value = await request.json();
  if (typeof value !== "object" || value === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
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
  initialSnapshotBase64 = null,
  refreshedToken = "collab_token_refreshed",
  roomName = "folio_collab_session_test",
  token = "collab_token_test",
  tokenExpiresAt = farFutureTokenExpiresAt(),
}: FakeStellaApiOptions = {}): FakeStellaApi => {
  let authorizeRequests = 0;
  let latestSnapshotBase64 = initialSnapshotBase64;
  let refreshRequests = 0;
  const storeRequestTokens: string[] = [];
  let storeRequests = 0;
  let currentToken = token;

  const server = Bun.serve({
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = await bodyString(request);

      if (url.pathname === "/v1/folio-collab-sessions/authorize") {
        authorizeRequests += 1;

        if (body["sessionId"] !== roomName || body["token"] !== token) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        return Response.json({
          canEdit,
          roomName,
          sessionId: roomName,
          tokenExpiresAt,
          userId: "user_test",
          workspaceId: "workspace_test",
        });
      }

      if (url.pathname === "/v1/folio-collab-sessions/refresh-token") {
        refreshRequests += 1;

        if (body["sessionId"] !== roomName || body["token"] !== currentToken) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        currentToken = refreshedToken;
        return Response.json({
          token: refreshedToken,
          tokenExpiresAt: farFutureTokenExpiresAt(),
        });
      }

      if (url.pathname === "/v1/folio-collab-sessions/snapshot/load") {
        if (body["sessionId"] !== roomName || body["token"] !== currentToken) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        return Response.json({ snapshotBase64: latestSnapshotBase64 });
      }

      if (url.pathname === "/v1/folio-collab-sessions/snapshot/store") {
        if (body["sessionId"] !== roomName || body["token"] !== currentToken) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }

        storeRequests += 1;
        storeRequestTokens.push(body["token"] ?? "");
        latestSnapshotBase64 = body["snapshotBase64"] ?? null;

        return Response.json({ storedAt: new Date().toISOString() });
      }

      return Response.json({ message: "Not found" }, { status: 404 });
    },
    port: 0,
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("Fake Stella API did not expose a listening port.");
  }

  return {
    authorizeRequests: () => authorizeRequests,
    destroy: async () => {
      await server.stop(true);
    },
    latestSnapshotBase64: () => latestSnapshotBase64,
    refreshRequests: () => refreshRequests,
    storeRequestTokens: () => storeRequestTokens,
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
      name: "folio_collab_session_test",
      token: "collab_token_test",
      url: collabServer.websocketUrl,
      ydoc: firstDoc,
    });
    const secondProvider = createProvider({
      name: "folio_collab_session_test",
      token: "collab_token_test",
      url: collabServer.websocketUrl,
      ydoc: secondDoc,
    });

    try {
      await waitFor(
        () => firstProvider.isAuthenticated && secondProvider.isAuthenticated,
        "Providers did not authenticate.",
      );

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

  test("refreshes the Stella API token before storing snapshots", async () => {
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
      name: "folio_collab_session_test",
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
    } finally {
      provider.destroy();
      ydoc.destroy();
      await collabServer.destroy();
      await fakeApi.destroy();
    }
  });

  test("rejects clients when Stella API authorization fails", async () => {
    const fakeApi = createFakeStellaApi();
    const collabServer = await createCollabServer({
      apiUrl: fakeApi.url,
      debounceMs: 20,
      maxDebounceMs: 100,
      port: 0,
    });
    const ydoc = new Doc();
    let authenticationFailed = false;
    let provider: HocuspocusProvider | null = null;

    try {
      provider = new HocuspocusProvider({
        document: ydoc,
        name: "folio_collab_session_test",
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
});
