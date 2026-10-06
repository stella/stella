import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import api from "@/api/server";

import { VISUAL_INNER_POLICY } from "./document";

describe("visual sandbox page", () => {
  test("serves a private frame shell under global API response headers", async () => {
    const response = await api.handle(
      new Request("http://localhost/visual-sandbox"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response.headers.get("X-Frame-Options")).toBeNull();
    expect(response.headers.get("X-DNS-Prefetch-Control")).toBe("off");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      `${VISUAL_INNER_POLICY}; frame-ancestors ${new URL(env.FRONTEND_URL).origin}`,
    );
    expect(VISUAL_INNER_POLICY).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; worker-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; base-uri 'none'; object-src 'none'; manifest-src 'none'",
    );
  });

  test("query parameters do not change the bundled page or its policy", async () => {
    const plain = await api.handle(
      new Request("http://localhost/visual-sandbox"),
    );
    const query = await api.handle(
      new Request("http://localhost/visual-sandbox?title=Timeline"),
    );
    expect(await query.text()).toBe(await plain.text());
    expect(query.headers.get("Content-Security-Policy")).toBe(
      plain.headers.get("Content-Security-Policy"),
    );
  });
});
