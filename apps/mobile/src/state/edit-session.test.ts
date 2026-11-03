import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";
import { ExpoFormData } from "@/connection/test-support/expo-form-data";
import { DOCX_MIME_TYPE } from "@/state/document-file";

import {
  checkpointEditSession,
  openEditSession,
  releaseEditLock,
  sessionTakenOver,
} from "./edit-session";

const SESSION: StoredSession = {
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  signInId: "sign-in-1",
  refreshToken: "refresh-1",
  userId: "user-1",
};

const sourceFor = (fetch: Fetch) => {
  const store = createSessionStore({
    read: async () => SESSION,
    write: async () => {},
    prepareClear: async () => {},
    clear: async () => {},
  });
  return createAccessTokenSource({
    fetch,
    initialAccess: { token: "access-0", expiresAt: Number.MAX_SAFE_INTEGER },
    now: () => 0,
    session: SESSION,
    generation: store.generation(),
    store,
  });
};

type Sent = {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Headers;
  readonly body: unknown;
};

const server = (answer: () => Response) => {
  const sent: Sent[] = [];
  const fetch: Fetch = async (url, init) => {
    sent.push({
      url,
      method: init?.method,
      headers: new Headers(init?.headers),
      body: init?.body,
    });
    return answer();
  };
  return { fetch, sent };
};

const TARGET = {
  workspaceId: "matter-1",
  entityId: "entity-1",
  propertyId: "property-1",
} as const;

const EDITING = {
  sessionId: "session-1",
  sessionToken: "t".repeat(64),
  fileName: "Smlouva.docx",
} as const;

// The edited document as the phone hands it over, here under no type: what
// the platform guesses from the name is not what goes up.
const EDITED = new File([new Uint8Array([80, 75, 3, 4])], "edit.docx", {
  type: "",
});

const BUN_FORM_DATA = globalThis.FormData;
beforeEach(() => {
  globalThis.FormData = ExpoFormData;
});
afterEach(() => {
  globalThis.FormData = BUN_FORM_DATA;
});

describe("opening a document for editing", () => {
  test("asks the matter's edit lock for the document's file column and hands back the session and its working copy", async () => {
    const { fetch, sent } = server(() =>
      Response.json({
        baseVersionNumber: 3,
        downloadUrl: "https://storage.example.com/working-copy?signature=abc",
        fileName: "Smlouva.docx",
        fileType: "docx",
        lastCheckpointAt: null,
        resumedFromCheckpoint: false,
        sessionId: "session-1",
        sessionToken: EDITING.sessionToken,
        tookOverExistingSession: false,
      }),
    );

    const result = await openEditSession({
      fetch,
      source: sourceFor(fetch),
      ...TARGET,
    });

    expect(result.unwrap()).toEqual({
      ...EDITING,
      downloadUrl: "https://storage.example.com/working-copy?signature=abc",
    });
    expect(sent.map(({ url, method }) => [method, url])).toEqual([
      [
        "POST",
        "https://stella.example.com/v1/entities/matter-1/desktop-edit-sessions/open",
      ],
    ]);
    expect(JSON.parse(String(sent[0]?.body))).toEqual({
      entityId: "entity-1",
      propertyId: "property-1",
    });
  });
});

describe("storing a checkpoint", () => {
  test("uploads the edited file with the session token as multipart and takes the rotated token", async () => {
    const { fetch, sent } = server(() =>
      Response.json({ rotatedSessionToken: "r".repeat(64) }),
    );

    const result = await checkpointEditSession({
      fetch,
      source: sourceFor(fetch),
      session: EDITING,
      file: EDITED,
    });

    expect(result.unwrap()).toEqual({
      ...EDITING,
      sessionToken: "r".repeat(64),
    });
    const [request] = sent;
    expect(request?.url).toBe(
      "https://stella.example.com/v1/desktop-edit-sessions/session-1/checkpoint",
    );
    // The platform writes the multipart boundary; a JSON type would hide it.
    expect(request?.headers.get("content-type")).toBeNull();
    const form =
      request?.body instanceof ExpoFormData ? request.body : undefined;
    expect([...(form?.keys() ?? [])]).toEqual(["file", "sessionToken"]);
    expect(form?.get("sessionToken")).toBe(EDITING.sessionToken);
    // The document itself goes up, as a Word document, not a stand-in for it.
    const sentFile = form?.part("file");
    expect(sentFile?.name).toBe("edit.docx");
    expect(sentFile?.type).toBe(DOCX_MIME_TYPE);
    expect(await sentFile?.bytes()).toEqual(await EDITED.bytes());
  });

  test("keeps the token when the server does not rotate it", async () => {
    const { fetch } = server(() => Response.json({}));

    const result = await checkpointEditSession({
      fetch,
      source: sourceFor(fetch),
      session: EDITING,
      file: EDITED,
    });

    expect(result.unwrap()).toEqual(EDITING);
  });

  test.each([
    [409, true],
    [500, false],
    [413, false],
  ])("a %i refusal is a take-over: %p", async (status, takenOver) => {
    const { fetch } = server(() =>
      Response.json({ message: "refused" }, { status }),
    );

    const result = await checkpointEditSession({
      fetch,
      source: sourceFor(fetch),
      session: EDITING,
      file: EDITED,
    });

    expect(result.isErr() && sessionTakenOver(result.error)).toBe(takenOver);
  });
});

describe("giving the lock back", () => {
  test.each([
    [200, true],
    [503, false],
  ])("a %i answer means given back: %p", async (status, released) => {
    const { fetch, sent } = server(() => Response.json({}, { status }));

    expect(
      await releaseEditLock({ fetch, source: sourceFor(fetch), ...TARGET }),
    ).toBe(released);
    expect(sent[0]?.url).toBe(
      "https://stella.example.com/v1/entities/matter-1/desktop-edit-sessions/release",
    );
  });
});
