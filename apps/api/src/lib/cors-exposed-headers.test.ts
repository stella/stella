import { afterAll, expect, test } from "bun:test";

import { REQUEST_ID_HEADER } from "@stll/api-contract";
import {
  CLAUSE_WARNINGS_HEADER,
  UNDECIDED_CONDITIONS_HEADER,
} from "@stll/api-contract/template-fill-headers";

import { createHttpApp } from "@/api/http/app";
import { cors } from "@/api/http/cors";
import { routes } from "@/api/http/route";
import { serveForTest } from "@/api/tests/helpers/test-server";

import { CORS_EXPOSED_HEADERS } from "./security-headers";

const ALLOWED_ORIGIN = "https://app.example";

const server = serveForTest(
  createHttpApp({
    middleware: [
      cors({
        isAllowedOrigin: (origin) => origin === ALLOWED_ORIGIN,
        methods: ["GET"],
        allowedHeaders: ["Content-Type"],
        exposedHeaders: CORS_EXPOSED_HEADERS,
        maxAgeSeconds: 60,
      }),
    ],
    routes: routes({
      "/download": {
        GET: {
          access: "public",
          config: {},
          run: async () =>
            await Promise.resolve(
              new Response("document", {
                headers: {
                  [CLAUSE_WARNINGS_HEADER]: "1000000",
                  [REQUEST_ID_HEADER]: "req_download",
                },
              }),
            ),
        },
      },
    }),
  }),
);

afterAll(async () => {
  await server.stop();
});

const exposedHeaders = (response: Response): string[] | undefined =>
  response.headers
    .get("Access-Control-Expose-Headers")
    ?.split(",")
    .map((header) => header.trim().toLowerCase());

test("cross-origin downloads expose bounded clause warning counts and request receipts", async () => {
  const response = await server.fetch(
    new Request("http://localhost/download", {
      headers: { Origin: ALLOWED_ORIGIN },
    }),
  );
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
    ALLOWED_ORIGIN,
  );
  expect(exposedHeaders(response)).toContain(
    CLAUSE_WARNINGS_HEADER.toLowerCase(),
  );
  expect(exposedHeaders(response)).toContain(REQUEST_ID_HEADER);
  expect(response.headers.get(CLAUSE_WARNINGS_HEADER)).toBe("1000000");
  expect(response.headers.get(REQUEST_ID_HEADER)).toBe("req_download");
});

test("a download from another origin exposes nothing", async () => {
  const response = await server.fetch(
    new Request("http://localhost/download", {
      headers: { Origin: "https://elsewhere.example" },
    }),
  );
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  expect(response.headers.get("Access-Control-Expose-Headers")).toBeNull();
});

test("cross-origin downloads expose undecided AI conditions", () => {
  expect(CORS_EXPOSED_HEADERS).toContain(UNDECIDED_CONDITIONS_HEADER);
  expect(CORS_EXPOSED_HEADERS).toContain("X-Ai-Field-Errors");
});
