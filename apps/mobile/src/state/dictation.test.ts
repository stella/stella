import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import {
  createAccessTokenSource,
  createSessionStore,
  type StoredSession,
} from "@/connection/session";

import { appendDictation, transcribeRecording } from "./dictation";

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
      uri: "file:///cache/recording.m4a",
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
    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body instanceof FormData ? request.body : undefined;
    expect([...(form?.keys() ?? [])]).toEqual(["file"]);
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
      uri: "file:///cache/recording.m4a",
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
