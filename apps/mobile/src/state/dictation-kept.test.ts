import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { SignedOutError, TokenError } from "@/connection/errors";
import { ApiRequestError } from "@/state/api-request";

import {
  keptDictationSchema,
  keptFor,
  RecordingReadError,
  recordingsToTranscribe,
  RECOVERED_OFFER_MS,
  refusalOf,
  retriesByItself,
  retryDelayMs,
  stillOffered,
  transcribedTexts,
  withTranscribed,
} from "./dictation-kept";
import type { KeptDictation, KeptPiece } from "./dictation-kept";

const KEPT: KeptDictation = {
  id: "kept-1",
  serverUrl: "https://stella.example.com",
  userId: "user-1",
  field: "chat",
  matterId: "matter-1",
  modelId: null,
  modelClass: null,
  locale: "en",
  cleanup: false,
  style: "polished",
  translateTo: null,
  keptAt: 1000,
  state: {
    type: "waiting",
    refused: false,
    refusedFor: null,
    pieces: [
      { type: "text", text: "First part." },
      { type: "audio", file: "1.m4a" },
      { type: "audio", file: "2.m4a" },
    ],
  },
};

describe("kept dictations", () => {
  test("what is written reads back", () => {
    const read = v.safeParse(
      v.pipe(v.string(), v.parseJson(), keptDictationSchema),
      JSON.stringify(KEPT),
    );
    expect(read).toMatchObject({ success: true, output: KEPT });
  });

  test("a recording outside the dictation's folder does not read", () => {
    const outside = {
      ...KEPT,
      state: {
        type: "waiting",
        refused: false,
        refusedFor: null,
        pieces: [{ type: "audio", file: "../x" }],
      },
    };
    expect(v.safeParse(keptDictationSchema, outside).success).toBe(false);
  });

  test("belongs to its own account only", () => {
    expect(keptFor(KEPT, KEPT)).toBe(true);
    expect(keptFor(KEPT, { ...KEPT, userId: "user-2" })).toBe(false);
    expect(
      keptFor(KEPT, { ...KEPT, serverUrl: "https://other.example.com" }),
    ).toBe(false);
  });

  test("being offline or a server in trouble retries by itself; a refusal waits", () => {
    const failure = (status?: number) =>
      new ApiRequestError({ message: "synthetic", status });
    expect(retriesByItself(failure())).toBe(true);
    expect(retriesByItself(failure(408))).toBe(true);
    expect(retriesByItself(failure(429))).toBe(true);
    expect(retriesByItself(failure(502))).toBe(true);
    expect(retriesByItself(failure(400))).toBe(false);
    expect(retriesByItself(failure(413))).toBe(false);
    const unserved = new ApiRequestError({
      message: "synthetic",
      status: 503,
      code: "transcription_model_unavailable",
    });
    expect(retriesByItself(unserved)).toBe(false);
    const timedOut = new ApiRequestError({
      message: "synthetic",
      status: 503,
      code: "ai_deadline_exceeded",
    });
    expect(retriesByItself(timedOut)).toBe(true);
    expect(retriesByItself(new TokenError({ message: "synthetic" }))).toBe(
      true,
    );
    expect(retriesByItself(new SignedOutError({ message: "synthetic" }))).toBe(
      false,
    );
    expect(
      retriesByItself(new RecordingReadError({ message: "synthetic" })),
    ).toBe(false);
  });

  test("waits longer after each failed retry, up to ten minutes", () => {
    const delays = [1, 2, 3, 4, 5, 6, 20].map(retryDelayMs);
    expect(delays).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000,
    ]);
  });

  test("a recovered text is offered for ten minutes", () => {
    const recovered: KeptDictation = {
      ...KEPT,
      state: {
        type: "recovered",
        text: "Done.",
        names: [],
        recoveredAt: 5000,
      },
    };
    expect(stillOffered(recovered, 5000)).toBe(true);
    expect(stillOffered(recovered, 5000 + RECOVERED_OFFER_MS - 1)).toBe(true);
    expect(stillOffered(recovered, 5000 + RECOVERED_OFFER_MS)).toBe(false);
    expect(stillOffered(KEPT, 5000)).toBe(false);
  });

  test("a retry keeps the spoken order, whichever recordings it transcribed", () => {
    const pieces: readonly KeptPiece[] =
      KEPT.state.type === "waiting" ? KEPT.state.pieces : [];
    expect(recordingsToTranscribe(pieces)).toEqual(["1.m4a", "2.m4a"]);

    const partly = withTranscribed(pieces, new Map([["2.m4a", "Third."]]));
    expect(recordingsToTranscribe(partly)).toEqual(["1.m4a"]);
    expect(transcribedTexts(partly)).toBeNull();

    const done = withTranscribed(partly, new Map([["1.m4a", "Second."]]));
    expect(transcribedTexts(done)).toEqual([
      "First part.",
      "Second.",
      "Third.",
    ]);
  });

  test("only a model the server does not serve is a refusal for the model", () => {
    expect(
      refusalOf(
        new ApiRequestError({
          message: "synthetic",
          status: 503,
          code: "transcription_model_unavailable",
        }),
      ),
    ).toBe("model");
    expect(
      refusalOf(new ApiRequestError({ message: "synthetic", status: 400 })),
    ).toBeNull();
    expect(
      refusalOf(new RecordingReadError({ message: "synthetic" })),
    ).toBeNull();
  });
});
