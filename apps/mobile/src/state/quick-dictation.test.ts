import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";
import { ExpoFormData } from "@/connection/test-support/expo-form-data";

import {
  DICTATION_CHUNK_RULES,
  DICTATION_TOTAL_MAX_MS,
} from "./dictation-chunks";
import { DEFAULT_DICTATION_PREFERENCES } from "./dictation-preferences";
import {
  DICTATION_ACTIVITY_CLOCK,
  DICTATION_ACTIVITY_NAME,
  DICTATION_CANCEL_TARGET,
  dictationDocument,
  QUICK_DICTATION_KEEP_MS,
  quickDictationConfiguration,
  transcribeQuickDictation,
} from "./quick-dictation";

const BUN_FORM_DATA = globalThis.FormData;
beforeEach(() => {
  globalThis.FormData = ExpoFormData;
});
afterEach(() => {
  globalThis.FormData = BUN_FORM_DATA;
});

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

/** One recorded piece, named for the order it was spoken in. */
const piece = (index: number) =>
  new File([new Uint8Array([0, 0, 0, 24, index])], `piece-${index}.m4a`, {
    type: "audio/mp4",
  });

type Sent = {
  readonly path: string;
  readonly form: FormData | undefined;
  readonly body: string | undefined;
};

/**
 * A server that answers each transcription by the piece it was sent, and
 * cleanup with `cleaned`.
 */
const server = ({
  cleaned = "Cleaned.",
  models = [],
  transcribe,
}: {
  cleaned?: string;
  models?: readonly { id: string; provider: string }[];
  transcribe: (name: string, modelId: string | null) => Response;
}) => {
  const sent: Sent[] = [];
  const fetch: Fetch = async (url, init) => {
    const { pathname } = new URL(url);
    const form = init?.body instanceof ExpoFormData ? init.body : undefined;
    sent.push({
      path: pathname,
      form,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    if (pathname === "/v1/dictation/models") {
      return Response.json({
        models: models.map((model) => ({ ...model, displayName: model.id })),
        defaultModelId: null,
        unavailable: null,
      });
    }
    if (pathname === "/v1/dictation/cleanup") {
      return Response.json({
        segments: [{ type: "text", text: cleaned, bold: false }],
      });
    }
    const name = form?.part("file")?.name ?? "";
    const model = form?.get("modelId");
    return transcribe(name, typeof model === "string" ? model : null);
  };
  return { fetch, sent };
};

const text = (value: string) =>
  Response.json({
    text: value,
    segments: [],
    detectedLanguage: "cs",
    durationMs: 1000,
    modelId: "model",
    vocabulary: "not-supported",
  });

describe("a dictation started outside the app", () => {
  test("joins its pieces' texts in spoken order, however the answers arrive", async () => {
    const { fetch } = server({
      transcribe: (name) =>
        text(name === "piece-0.m4a" ? " Prosím o návrh " : "smlouvy."),
    });
    const result = await transcribeQuickDictation({
      fetch,
      learned: [],
      locale: "cs",
      pieces: [piece(0), piece(1)],
      preferences: DEFAULT_DICTATION_PREFERENCES,
      source: sourceFor(fetch),
    });
    expect(result).toEqual({
      type: "text",
      text: "Prosím o návrh smlouvy.",
    });
  });

  test("a piece that fails leaves its recording to keep, the others' texts kept with it", async () => {
    const { fetch } = server({
      transcribe: (name) =>
        name === "piece-1.m4a"
          ? Response.json({ message: "Busy" }, { status: 500 })
          : text("Prosím"),
    });
    const result = await transcribeQuickDictation({
      fetch,
      learned: [],
      locale: "cs",
      pieces: [piece(0), piece(1)],
      preferences: DEFAULT_DICTATION_PREFERENCES,
      source: sourceFor(fetch),
    });
    expect(result).toEqual({
      type: "failed",
      signedOut: false,
      pieces: [
        { type: "text", text: "Prosím" },
        { type: "audio", index: 1 },
      ],
      refused: false,
      refusedFor: null,
    });
  });

  test("nothing heard in any piece is silence, not an empty text", async () => {
    const { fetch, sent } = server({ transcribe: () => text("  ") });
    const result = await transcribeQuickDictation({
      fetch,
      learned: [],
      locale: "cs",
      pieces: [piece(0)],
      preferences: { ...DEFAULT_DICTATION_PREFERENCES, cleanup: true },
      source: sourceFor(fetch),
    });
    expect(result).toEqual({ type: "silent" });
    expect(sent.map(({ path }) => path)).toEqual(["/v1/dictation/transcribe"]);
  });

  test("a model the server cannot serve gives way only to one of its provider, region and retention", async () => {
    const { fetch, sent } = server({
      models: [
        { id: "other/model", provider: "Provider B" },
        { id: "sibling/model", provider: "Provider A" },
      ],
      transcribe: (_name, model) =>
        model === "gone/model"
          ? Response.json({ message: "Unavailable" }, { status: 503 })
          : text("Prosím"),
    });
    const result = await transcribeQuickDictation({
      fetch,
      learned: [],
      locale: "cs",
      pieces: [piece(0)],
      preferences: {
        ...DEFAULT_DICTATION_PREFERENCES,
        modelId: "gone/model",
        modelClass: {
          provider: "Provider A",
          outsideRegion: false,
          retainsData: false,
        },
      },
      source: sourceFor(fetch),
    });
    expect(result).toEqual({ type: "text", text: "Prosím" });
    expect(
      sent
        .filter(({ path }) => path === "/v1/dictation/transcribe")
        .map(({ form }) => form?.get("modelId") ?? null),
    ).toEqual(["gone/model", "sibling/model"]);
  });

  test("a model the server cannot serve, of no class known, sends the recording nowhere else", async () => {
    const { fetch, sent } = server({
      models: [{ id: "default/model", provider: "Provider A" }],
      transcribe: (_name, model) =>
        model === "gone/model"
          ? Response.json({ message: "Unavailable" }, { status: 503 })
          : text("Prosím"),
    });
    const result = await transcribeQuickDictation({
      fetch,
      learned: [],
      locale: "cs",
      pieces: [piece(0)],
      preferences: { ...DEFAULT_DICTATION_PREFERENCES, modelId: "gone/model" },
      source: sourceFor(fetch),
    });
    expect(result).toMatchObject({
      type: "failed",
      pieces: [{ type: "audio", index: 0 }],
    });
    expect(
      sent
        .filter(({ path }) => path === "/v1/dictation/transcribe")
        .map(({ form }) => form?.get("modelId") ?? null),
    ).toEqual(["gone/model"]);
  });

  test("a model refused as unserved waits for the person to pick another", async () => {
    const { fetch } = server({
      transcribe: () =>
        Response.json(
          {
            message: "Unavailable",
            code: "transcription_model_unavailable",
          },
          { status: 400 },
        ),
    });
    const result = await transcribeQuickDictation({
      fetch,
      learned: [],
      locale: "cs",
      pieces: [piece(0)],
      preferences: { ...DEFAULT_DICTATION_PREFERENCES, modelId: "gone/model" },
      source: sourceFor(fetch),
    });
    expect(result).toMatchObject({
      type: "failed",
      refused: true,
      refusedFor: "model",
    });
  });

  test("cleanup tidies the joined text when the person turned it on", async () => {
    const { fetch } = server({
      cleaned: "Prosím o návrh smlouvy.",
      transcribe: () => text("prosím o návrh smlouvy tečka"),
    });
    const result = await transcribeQuickDictation({
      fetch,
      learned: [],
      locale: "cs",
      pieces: [piece(0)],
      preferences: { ...DEFAULT_DICTATION_PREFERENCES, cleanup: true },
      source: sourceFor(fetch),
    });
    expect(result).toEqual({
      type: "text",
      text: "Prosím o návrh smlouvy.",
    });
  });

  test("cleanup writes in the style and language the person picked", async () => {
    const { fetch, sent } = server({
      transcribe: () => text("zavolat klientovi"),
    });
    await transcribeQuickDictation({
      fetch,
      learned: [],
      locale: "cs",
      pieces: [piece(0)],
      preferences: {
        ...DEFAULT_DICTATION_PREFERENCES,
        cleanup: true,
        style: "notes",
        translateTo: "en",
      },
      source: sourceFor(fetch),
    });
    const cleanup = sent.find(({ path }) => path === "/v1/dictation/cleanup");
    expect(JSON.parse(cleanup?.body ?? "")).toMatchObject({
      style: "notes",
      translateTo: "en",
    });
  });

  test("the native side gets both faces of the activity and the composer's cutting rules", () => {
    const configuration = quickDictationConfiguration({
      labels: {
        cancel: "Cancel dictation",
        finish: "Done dictating",
        readyDetail: "Tap to review",
        readyTitle: "Ready",
        recordingDetail: "Tap Done",
        recordingTitle: "Dictating",
      },
      link: "app.stll.dev://dictation",
    });
    expect(configuration.activityName).toBe(DICTATION_ACTIVITY_NAME);
    expect(configuration.cancelTarget).toBe(DICTATION_CANCEL_TARGET);
    for (const face of [configuration.recording, configuration.ready]) {
      expect(face.cancelTarget).toBe(DICTATION_CANCEL_TARGET);
      expect(face.link).toBe("app.stll.dev://dictation");
      expect(face[DICTATION_ACTIVITY_CLOCK]).toBe(0);
    }
    expect(configuration.recording.phase).toBe("recording");
    expect(configuration.ready.phase).toBe("ready");
    expect(configuration.rules).toEqual({
      ...DICTATION_CHUNK_RULES,
      totalMaxMs: DICTATION_TOTAL_MAX_MS,
      keepMs: QUICK_DICTATION_KEEP_MS,
    });
  });

  test("saved to a matter, the text is a plain text document ending in a new line", () => {
    expect(
      dictationDocument({
        text: "Prosím o návrh.",
        title: "Diktát 21. 11. 2026 15:04",
      }),
    ).toEqual({
      name: "Diktát 21. 11. 2026 15:04.txt",
      mimeType: "text/plain",
      contents: "Prosím o návrh.\n",
    });
  });
});
