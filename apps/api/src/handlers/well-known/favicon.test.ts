import { afterAll, describe, expect, test } from "bun:test";

import { apiApp } from "@/api/server";
import { serveForTest } from "@/api/tests/helpers/test-server";

const api = serveForTest(apiApp);
afterAll(async () => {
  await api.stop();
});

describe("API host favicon", () => {
  test("serves the stella icon without credentials", async () => {
    const response = await api.fetch(
      new Request("http://localhost/favicon.ico"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=86400, stale-while-revalidate=604800",
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
    // PNG signature: the body is the image, not an error document.
    expect([...bytes.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });
});
