import { expect, test } from "bun:test";

import { API_RATE_LIMITS } from "@/api/lib/limits";

import { consumeEmailAttachmentSaveRateLimit } from "./email-attachment-save-rate-limit";

test("email attachment saves consume the shared upload budget", async () => {
  const seenKeys: string[] = [];
  const request = new Request("https://stella.example/v1/files/ws/save");
  const server = {
    requestIP: () => ({ address: "192.0.2.1" }),
  };
  const result = await consumeEmailAttachmentSaveRateLimit({
    context: {
      increment: async (key, duration) => {
        seenKeys.push(key);
        expect(duration).toBe(API_RATE_LIMITS.upload.duration);
        return {
          count: API_RATE_LIMITS.upload.max + 1,
          nextReset: new Date(),
          start: Date.now(),
        };
      },
    },
    request,
    server,
  });

  expect(result).toBe(false);
  expect(seenKeys).toEqual(["upload:192.0.2.1"]);
});
