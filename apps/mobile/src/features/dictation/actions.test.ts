import { describe, expect, test } from "bun:test";

import type { Fetch } from "@/connection/http";
import { createAccessTokenSource } from "@/connection/session";
import type { StoredSession } from "@/connection/session";

import { exportDictation, saveDictationToMatter } from "./actions";

const SESSION: StoredSession = {
  userId: "user-žofie",
  serverUrl: "https://stella.example.com",
  issuer: "https://stella.example.com/api/auth",
  clientId:
    "https://stella.example.com/v1/mcp/oauth/mobile-client-metadata.json",
  tokenEndpoint: "https://stella.example.com/api/auth/oauth2/token",
  resource: "https://stella.example.com/v1",
  refreshToken: "refresh-1",
};
const audio = {
  uri: "file:///draft/recording.m4a",
  size: 4,
  sha256Hex: "a".repeat(64),
};
type Fault = "presign" | "put-timeout" | "finalize" | "none";
const world = (initial: Fault) => {
  let fault = initial;
  let finalized = 0;
  const fetch: Fetch = async (url, init) => {
    if (url === audio.uri) {
      return new Response("AAC!");
    }
    if (url === "https://storage.example.com/audio") {
      expect(init?.method).toBe("PUT");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (fault === "put-timeout") {
        throw new DOMException("Transfer deadline", "TimeoutError");
      }
      return new Response(null, { status: 200 });
    }
    if (url.endsWith("/properties/matter-1")) {
      return Response.json([{ id: "files", content: { type: "file" } }]);
    }
    if (url.endsWith("/presign")) {
      if (fault === "presign") {
        return Response.json({ message: "Unavailable" }, { status: 503 });
      }
      expect(JSON.parse(String(init?.body))).toMatchObject({
        name: "Diktát Žofie Černé.m4a",
        mimeType: "audio/mp4",
      });
      return Response.json({
        uploadId: "upload-1",
        url: "https://storage.example.com/audio",
        headers: {},
      });
    }
    if (url.endsWith("/finalize")) {
      if (fault === "finalize") {
        return Response.json({ message: "Unavailable" }, { status: 503 });
      }
      finalized += 1;
      return Response.json({ finalizedResult: { entityId: "document-1" } });
    }
    return Response.json({ ok: true });
  };
  const source = createAccessTokenSource({
    fetch,
    now: () => 0,
    session: SESSION,
    initialAccess: { token: "access", expiresAt: Number.MAX_SAFE_INTEGER },
    store: {
      read: async () => SESSION,
      write: async () => {},
      clear: async () => {},
    },
  });
  const drafts = new Set(["draft-1"]);
  const save = async () =>
    await saveDictationToMatter({
      fetch,
      source,
      draftId: "draft-1",
      cleaned: false,
      matterId: "matter-1",
      name: "Diktát Žofie Černé",
      exportAudio: async (id) => {
        expect(drafts.has(id)).toBe(true);
        return audio;
      },
    });
  return {
    save,
    drafts,
    recover: () => {
      fault = "none";
    },
    finalized: () => finalized,
  };
};

describe("dictation actions", () => {
  test.each(["presign", "put-timeout", "finalize"] as const)(
    "%s failure preserves the recording and retry completes",
    async (fault) => {
      const app = world(fault);
      expect((await app.save()).isErr()).toBe(true);
      expect(app.drafts.has("draft-1")).toBe(true);
      expect(app.finalized()).toBe(0);
      app.recover();
      expect((await app.save()).unwrap()).toBe("document-1");
      expect(app.finalized()).toBe(1);
      expect(app.drafts.has("draft-1")).toBe(true);
    },
  );

  test("export cancellation keeps the draft and returns cancellation", async () => {
    const exported = await exportDictation({
      draftId: "draft-1",
      cleaned: true,
      exportAudio: async (_id, cleaned) => {
        expect(cleaned).toBe(true);
        return audio;
      },
      shareAudio: async (uri) => {
        expect(uri).toBe(audio.uri);
        return false;
      },
    });
    expect(exported.unwrap()).toBe(false);
  });

  test("export and share failures are propagated", async () => {
    for (const step of ["export", "share"] as const) {
      const exported = await exportDictation({
        draftId: "draft-1",
        cleaned: false,
        exportAudio: async () => {
          if (step === "export") {
            throw new TypeError("Unreadable audio");
          }
          return audio;
        },
        shareAudio: async () => {
          throw new TypeError("Share unavailable");
        },
      });
      expect(exported.isErr() && exported.error._tag).toBe(
        "DictationActionError",
      );
    }
  });
});
