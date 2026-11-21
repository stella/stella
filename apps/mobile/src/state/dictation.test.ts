import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";
import { ExpoFormData } from "@/connection/test-support/expo-form-data";

import {
  appendDictation,
  cleanUpDictation,
  readDictationModels,
  readMatterVocabulary,
  segmentsText,
  transcribeRecording,
  vocabularyTerms,
} from "./dictation";

// A recording as Android hands it over: a file, which Expo's `fetch` reads
// as bytes, under the type the platform guesses from its name.
const RECORDING = new File(
  [new Uint8Array([0, 0, 0, 24, 102, 116])],
  "rec.m4a",
  {
    type: "audio/mpeg",
  },
);

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

describe("transcribing a recording", () => {
  test("uploads the file as multipart to the transcription route, names no model, and returns the trimmed text", async () => {
    const { fetch, sent } = server(() =>
      Response.json({
        text: "  Prosím o návrh smlouvy.  ",
        segments: [],
        detectedLanguage: "cs",
        durationMs: 2100,
        modelId: "mistralai/voxtral-mini-transcribe",
        vocabulary: "not-supported",
      }),
    );

    const result = await transcribeRecording({
      fetch,
      source: sourceFor(fetch),
      audio: RECORDING,
    });

    expect(result.unwrap()).toBe("Prosím o návrh smlouvy.");
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe(
      "https://stella.example.com/v1/dictation/transcribe",
    );
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("authorization")).toBe("Bearer access-0");
    // The platform writes the multipart boundary; a JSON type would hide it.
    expect(request?.headers.get("content-type")).toBeNull();
    expect(request?.body).toBeInstanceOf(ExpoFormData);
    const form =
      request?.body instanceof ExpoFormData ? request.body : undefined;
    expect([...(form?.keys() ?? [])]).toEqual(["file"]);
    // The recording itself goes up, as the type the server takes rather
    // than the platform's guess, not a stand-in for it.
    const sentFile = form?.part("file");
    expect(sentFile?.name).toBe("rec.m4a");
    expect(sentFile?.type).toBe("audio/mp4");
    expect(await sentFile?.bytes()).toEqual(await RECORDING.bytes());
  });

  test("a refusal keeps the server's status and words", async () => {
    const { fetch } = server(() =>
      Response.json(
        {
          code: "transcription_model_unavailable",
          message: "No transcription model is available in your region",
        },
        { status: 503 },
      ),
    );

    const result = await transcribeRecording({
      fetch,
      source: sourceFor(fetch),
      audio: RECORDING,
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }
    expect(result.error._tag).toBe("ApiRequestError");
    expect(
      result.error._tag === "ApiRequestError"
        ? [result.error.status, result.error.detail]
        : [],
    ).toEqual([503, "No transcription model is available in your region"]);
  });
});

describe("transcribing with a choice", () => {
  const answered = () =>
    Response.json({
      text: "Smlouva pro Novák s.r.o.",
      segments: [],
      detectedLanguage: "cs",
      durationMs: 2100,
      modelId: "elevenlabs/scribe-v3",
      vocabulary: "applied",
    });

  test("a picked model goes with the mark that its labels were shown, and a matter with its names", async () => {
    const { fetch, sent } = server(answered);

    await transcribeRecording({
      fetch,
      source: sourceFor(fetch),
      audio: RECORDING,
      choice: {
        modelId: "elevenlabs/scribe-v3",
        matterId: "matter-1",
        vocabulary: ["Novák s.r.o.", "25 C 12/2026"],
      },
    });

    const form =
      sent[0]?.body instanceof ExpoFormData ? sent[0].body : undefined;
    expect([...(form?.keys() ?? [])]).toEqual([
      "file",
      "modelId",
      "labels",
      "matterId",
      "vocabulary",
    ]);
    expect(form?.get("modelId")).toBe("elevenlabs/scribe-v3");
    expect(form?.get("labels")).toBe("1");
    expect(form?.get("matterId")).toBe("matter-1");
    expect(form?.get("vocabulary")).toBe('["Novák s.r.o.","25 C 12/2026"]');
  });

  test("no model and no names send neither, nor the labels mark", async () => {
    const { fetch, sent } = server(answered);

    await transcribeRecording({
      fetch,
      source: sourceFor(fetch),
      audio: RECORDING,
      choice: { vocabulary: [] },
    });

    const form =
      sent[0]?.body instanceof ExpoFormData ? sent[0].body : undefined;
    expect([...(form?.keys() ?? [])]).toEqual(["file"]);
  });
});

describe("the models a person may pick", () => {
  test("are read from the member route", async () => {
    const models = {
      models: [
        {
          id: "elevenlabs/scribe-v3",
          displayName: "Scribe v3",
          provider: "ElevenLabs",
          outsideRegion: true,
          retainsData: true,
        },
      ],
      defaultModelId: "mistralai/voxtral-mini-transcribe",
      unavailable: null,
    };
    const { fetch, sent } = server(() => Response.json(models));

    const result = await readDictationModels({
      fetch,
      source: sourceFor(fetch),
    });

    expect(result.unwrap()).toEqual(models);
    expect(sent[0]?.url).toBe("https://stella.example.com/v1/dictation/models");
    expect(sent[0]?.method).toBe("GET");
  });
});

describe("a matter's names", () => {
  test("are read for the matter, the weightiest first", async () => {
    const { fetch, sent } = server(() =>
      Response.json({
        candidates: [
          { term: "Smlouva o dílo", kind: "document", weight: 1 },
          { term: "Novák s.r.o.", kind: "client", weight: 5 },
        ],
      }),
    );

    const result = await readMatterVocabulary({
      fetch,
      source: sourceFor(fetch),
      matterId: "matter-1",
    });

    expect(result.unwrap()).toEqual(["Novák s.r.o.", "Smlouva o dílo"]);
    expect(sent[0]?.url).toBe(
      "https://stella.example.com/v1/workspaces/matter-1/vocabulary",
    );
  });

  test("keep only terms one transcription takes, each once", () => {
    const terms = vocabularyTerms([
      { term: "Novák", weight: 3 },
      { term: " Novák ", weight: 2 },
      { term: "x".repeat(101), weight: 9 },
      { term: " ", weight: 9 },
      ...Array.from({ length: 120 }, (_, index) => ({
        term: `term ${index}`,
        weight: 1,
      })),
    ]);

    expect(terms[0]).toBe("Novák");
    expect(terms).toHaveLength(100);
    expect(new Set(terms).size).toBe(100);
  });
});

describe("cleaning up a dictation", () => {
  test("sends only the text, for a chat, and reads the segments back as text", async () => {
    const { fetch, sent } = server(() =>
      Response.json({
        segments: [
          { type: "text", text: "Dobrý den,", bold: false },
          { type: "paragraphBreak" },
          { type: "text", text: "posílám návrh.", bold: true },
        ],
      }),
    );

    const result = await cleanUpDictation({
      fetch,
      source: sourceFor(fetch),
      transcript: "dobrý den čárka nový odstavec posílám návrh",
      locale: "cs",
      style: "polished",
      translateTo: null,
    });

    expect(result.unwrap()).toBe("Dobrý den,\n\nposílám návrh.");
    expect(sent[0]?.url).toBe(
      "https://stella.example.com/v1/dictation/cleanup",
    );
    expect(JSON.parse(String(sent[0]?.body))).toEqual({
      transcript: "dobrý den čárka nový odstavec posílám návrh",
      locale: "cs",
      context: { appKind: "chat" },
    });
  });

  test("names a style and a language to write in, and asks an older server again without them", async () => {
    let answers = 0;
    const { fetch, sent } = server(() => {
      answers += 1;
      return answers === 1
        ? Response.json({ message: "Invalid body" }, { status: 422 })
        : Response.json({
            segments: [
              { type: "text", text: "1. Call the client", bold: false },
            ],
          });
    });

    const result = await cleanUpDictation({
      fetch,
      source: sourceFor(fetch),
      transcript: "first call the client",
      locale: "en",
      style: "notes",
      translateTo: "en",
    });

    expect(result.unwrap()).toBe("1. Call the client");
    expect(sent.map(({ body }) => JSON.parse(String(body)))).toEqual([
      {
        transcript: "first call the client",
        locale: "en",
        context: { appKind: "chat" },
        style: "notes",
        translateTo: "en",
      },
      {
        transcript: "first call the client",
        locale: "en",
        context: { appKind: "chat" },
      },
    ]);
  });

  test("a refused cleanup that named nothing new is not asked again", async () => {
    const { fetch, sent } = server(() =>
      Response.json({ message: "Invalid body" }, { status: 422 }),
    );

    const result = await cleanUpDictation({
      fetch,
      source: sourceFor(fetch),
      transcript: "call the client",
      locale: "en",
      style: "polished",
      translateTo: null,
    });

    expect(result.isErr()).toBe(true);
    expect(sent).toHaveLength(1);
  });

  test("a line break is one new line", () => {
    expect(
      segmentsText([
        { type: "text", text: "a", bold: false },
        { type: "lineBreak" },
        { type: "text", text: "b", bold: false },
      ]),
    ).toBe("a\nb");
  });
});

describe("adding dictated text to the box", () => {
  test.each([
    ["", "Dobrý den.", "Dobrý den."],
    ["Shrň", "smlouvu o dílo.", "Shrň smlouvu o dílo."],
    ["Shrň ", "smlouvu.", "Shrň smlouvu."],
    ["Shrň\n", "smlouvu.", "Shrň\nsmlouvu."],
    ["Shrň", "", "Shrň"],
  ])("%j then %j reads %j", (draft, dictated, expected) => {
    expect(appendDictation(draft, dictated)).toBe(expected);
  });
});
