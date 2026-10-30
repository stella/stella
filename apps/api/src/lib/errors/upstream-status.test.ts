import { expect, test } from "bun:test";

import { isRetryLaterStatus } from "@/api/lib/errors/upstream-status";

test("only timeouts, too-early replays, throttling and server errors mean retry later", () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504, 599]) {
    expect(isRetryLaterStatus(status), String(status)).toBe(true);
  }
  for (const status of [200, 304, 400, 401, 403, 404, 409, 422, 499]) {
    expect(isRetryLaterStatus(status), String(status)).toBe(false);
  }
});
