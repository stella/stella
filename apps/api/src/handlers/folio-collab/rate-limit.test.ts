import { describe, expect, test } from "bun:test";

import { isFolioCollabRateLimitedPath } from "@/api/handlers/folio-collab/rate-limit";

describe("folio-collab room rate limiting", () => {
  test("covers the folio-collab room endpoints", () => {
    expect(isFolioCollabRateLimitedPath("/v1/folio-collab-rooms")).toBe(true);
    expect(isFolioCollabRateLimitedPath("/v1/folio-collab-rooms/")).toBe(true);
    expect(
      isFolioCollabRateLimitedPath("/v1/folio-collab-rooms/room_1/token"),
    ).toBe(true);
  });

  test("does not cover unrelated endpoints", () => {
    expect(isFolioCollabRateLimitedPath("/v1/entities/ws_1/query")).toBe(false);
    expect(isFolioCollabRateLimitedPath("/v1/folio-collab-rooms-archive")).toBe(
      false,
    );
  });
});
