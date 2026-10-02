import type { ServerEntry } from "@tanstack/react-start/server-entry";
import { expect, mock, test } from "bun:test";

import { assertSsrDocument } from "@stll/ssr-testkit";

import {
  ROUTE_CACHE_CLASSES,
  SSR_CACHE_CLASS_HEADER,
} from "@/route-response-policy";
import { SSR_STATUS_HEADER } from "@/ssr-response-status";

const PUBLIC_POLICY = "public, max-age=300";
const DOCUMENT_POLICY = "private, no-store";
const HTML =
  "<html><head><title>stella</title></head><body><main>Catalogue</main></body></html>";
const REDIRECT_LOCATION = "/auth";
const STATUS_TEXT = "Fixture response";

await mock.module("@tanstack/react-start/server-entry", () => ({
  createServerEntry: (entry: ServerEntry) => entry,
  default: {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const headers = new Headers({ "Cache-Control": PUBLIC_POLICY });
      const cacheClass = url.searchParams.get("class");
      if (cacheClass !== null) {
        headers.set(SSR_CACHE_CLASS_HEADER, cacheClass);
      }
      const contentType = url.searchParams.get("type");
      if (contentType !== null) {
        headers.set("Content-Type", contentType);
      }
      const status = Number(url.searchParams.get("status") ?? 200);
      if (status === 302) {
        headers.set("Location", REDIRECT_LOCATION);
      }
      const requestedStatus = url.searchParams.get("documentStatus");
      if (requestedStatus !== null) {
        headers.set(SSR_STATUS_HEADER, requestedStatus);
      }
      if (url.searchParams.get("policy") === "absent") {
        headers.delete("Cache-Control");
      }
      return await Promise.resolve(
        new Response(HTML, { headers, status, statusText: STATUS_TEXT }),
      );
    },
  },
}));
const { default: server } = await import("@/server");

const cacheClasses = [...new Set(Object.values(ROUTE_CACHE_CLASSES))];
const mediaTypes = [
  null,
  "text/html",
  "Text/HTML ; charset=UTF-8",
  "application/json",
  "application/xml",
];
const statuses = [200, 302, 404, 500, 503];

for (const cacheClass of [null, ...cacheClasses]) {
  for (const contentType of mediaTypes) {
    for (const status of statuses) {
      test(`response policy: ${cacheClass ?? "default"}, ${contentType ?? "unspecified"}, ${status}`, async () => {
        const url = new URL("https://stella.test/law");
        if (cacheClass !== null) {
          url.searchParams.set("class", cacheClass);
        }
        if (contentType !== null) {
          url.searchParams.set("type", contentType);
        }
        url.searchParams.set("status", String(status));
        const response = await server.fetch(new Request(url));
        const successful = status === 200;
        const html =
          contentType?.toLowerCase().startsWith("text/html") ?? false;
        expect(response.headers.get("Cache-Control")).toBe(
          cacheClass === "public-anonymous" && successful && !html
            ? PUBLIC_POLICY
            : DOCUMENT_POLICY,
        );
        expect(response.headers.get("X-Robots-Tag")).toBe(
          cacheClass === "public-indexable" && successful && html
            ? null
            : "noindex",
        );
        expect(response.headers.get(SSR_CACHE_CLASS_HEADER)).toBeNull();
        expect(response.headers.get(SSR_STATUS_HEADER)).toBeNull();
        expect(response.status).toBe(status);
        expect(response.statusText).toBe(STATUS_TEXT);
        expect(response.headers.get("Location")).toBe(
          status === 302 ? REDIRECT_LOCATION : null,
        );
        expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe(
          "same-origin",
        );
        expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe(
          "credentialless",
        );
        const document = await response.text();
        if (html) {
          assertSsrDocument({
            contentType: response.headers.get("Content-Type"),
            html: document,
            requiredContent: ["<main>Catalogue</main>"],
            status: response.status,
            expectedStatus: status,
          });
        }
        expect(document).toBe(HTML);
      });
    }
  }
}

test("document status determines the final response policy", async () => {
  for (const cacheClass of cacheClasses) {
    const url = new URL("https://stella.test/law");
    url.searchParams.set("type", "text/html");
    url.searchParams.set("class", cacheClass);
    url.searchParams.set("documentStatus", "503");
    const response = await server.fetch(new Request(url));
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe(DOCUMENT_POLICY);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(response.headers.get(SSR_STATUS_HEADER)).toBeNull();
  }
});

test("a public response requires an explicit freshness policy", async () => {
  const response = await server.fetch(
    new Request(
      "https://stella.test/sitemap.xml?class=public-anonymous&policy=absent&type=application/xml",
    ),
  );
  expect(response.headers.get("Cache-Control")).toBe(DOCUMENT_POLICY);
});
