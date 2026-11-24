import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Base64 } from "@stll/sha256/bun";

import { ANONYMOUS_DOCUMENT_CACHE_CONTROL } from "@/route-response-policy";

import {
  getRequestNonce,
  withContentSecurityPolicy,
} from "./content-security-policy.server";

const environment = {
  apiBase: "https://stella.test/api",
  desktopBridgePort: 45_901,
  documentsBucket: "documents",
  documentsEndpoint: "https://objects.stella.test",
  sandboxUrls: ["https://stella.test/sandbox"],
};

const BOOT_SCRIPT = "window.boot = true;\r\nwindow.ready = true;";
const MODULE_SCRIPT = 'import("/assets/main.js")';
const STRUCTURED_DATA = '{"@context":"https://schema.org"}';

const documentWithNonce = (nonce: string) =>
  [
    "<!doctype html><html><head>",
    `<meta property="csp-nonce" nonce="${nonce}" content="${nonce}">`,
    `<link rel="modulepreload" href="/assets/main.js" nonce="${nonce}">`,
    `<script nonce="${nonce}" src="/prepaint-init.js"></script>`,
    `<script type="application/ld+json">${STRUCTURED_DATA}</script>`,
    "</head><body><main>Statute</main>",
    `<script nonce="${nonce}">${BOOT_SCRIPT}</script>`,
    `<script type="module" nonce="${nonce}">${MODULE_SCRIPT}</script>`,
    "</body></html>",
  ].join("");

const serve = async (cacheControl: string, body?: ReadableStream<Uint8Array>) =>
  await withContentSecurityPolicy({
    environment,
    fetchResponse: async () =>
      await Promise.resolve(
        new Response(body ?? documentWithNonce(getRequestNonce()), {
          headers: {
            "Cache-Control": cacheControl,
            "Content-Type": "text/html; charset=utf-8",
          },
        }),
      ),
  });

const scriptDirective = (response: Response) =>
  response.headers
    .get("Content-Security-Policy")
    ?.split("; ")
    .find((directive) => directive.startsWith("script-src "));

describe("document script policy", () => {
  test("a private document keeps its per-response nonce", async () => {
    const response = await serve("private, no-store");
    const html = await response.text();
    const nonce = /'nonce-([^']+)'/u.exec(scriptDirective(response) ?? "")?.[1];
    expect(nonce).toBeTruthy();
    expect(scriptDirective(response)).toContain("'strict-dynamic'");
    expect(html).toBe(documentWithNonce(nonce ?? ""));
  });

  test("a shareable document admits exactly its inline scripts by hash", async () => {
    const response = await serve(ANONYMOUS_DOCUMENT_CACHE_CONTROL);
    const html = await response.text();
    // The browser hashes the script after normalizing its newlines.
    expect(scriptDirective(response)).toBe(
      `script-src 'self' 'sha256-${sha256Base64(BOOT_SCRIPT.replace("\r\n", "\n"))}' 'sha256-${sha256Base64(MODULE_SCRIPT)}' 'wasm-unsafe-eval'`,
    );
    expect(html).not.toContain("nonce");
    expect(html).toContain('<script src="/prepaint-init.js"></script>');
    expect(html).toContain(`<script>${BOOT_SCRIPT}</script>`);
    expect(html).toContain(STRUCTURED_DATA);
    expect(response.headers.get("Cache-Control")).toBe(
      ANONYMOUS_DOCUMENT_CACHE_CONTROL,
    );
  });

  test("a body that fails still fails after the bytes it produced", async () => {
    const failure = new Error("render cut short");
    const chunks = [`<html><body><script>${BOOT_SCRIPT}</script>`];
    const encoder = new TextEncoder();
    const response = await serve(
      ANONYMOUS_DOCUMENT_CACHE_CONTROL,
      new ReadableStream<Uint8Array>({
        pull: (controller) => {
          const chunk = chunks.shift();
          if (chunk === undefined) {
            controller.error(failure);
            return;
          }
          controller.enqueue(encoder.encode(chunk));
        },
      }),
    );
    expect(scriptDirective(response)).toContain(
      `'sha256-${sha256Base64(BOOT_SCRIPT.replace("\r\n", "\n"))}'`,
    );
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new TypeError("document body missing");
    }
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(BOOT_SCRIPT);
    expect(await rejectionOf(reader.read())).toBe(failure);
    reader.releaseLock();
  });
});
