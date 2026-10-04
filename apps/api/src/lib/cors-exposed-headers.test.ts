import cors from "@elysia/cors";
import { expect, test } from "bun:test";
import { Elysia } from "elysia";

import { REQUEST_ID_HEADER } from "@stll/api-contract";
import {
  CLAUSE_WARNINGS_HEADER,
  UNDECIDED_CONDITIONS_HEADER,
} from "@stll/api-contract/template-fill-headers";

import { CORS_EXPOSED_HEADERS } from "./security-headers";

test("cross-origin downloads expose bounded clause warning counts and request receipts", async () => {
  const api = new Elysia()
    .use(
      cors({
        origin: "https://app.example",
        exposeHeaders: CORS_EXPOSED_HEADERS,
      }),
    )
    .get(
      "/download",
      () =>
        new Response("document", {
          headers: {
            [CLAUSE_WARNINGS_HEADER]: "1000000",
            [REQUEST_ID_HEADER]: "req_download",
          },
        }),
    );
  const response = await api.handle(
    new Request("http://localhost/download", {
      headers: { Origin: "https://app.example" },
    }),
  );
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
    "https://app.example",
  );
  expect(
    response.headers
      .get("Access-Control-Expose-Headers")
      ?.split(",")
      .map((header) => header.trim().toLowerCase()),
  ).toContain(CLAUSE_WARNINGS_HEADER.toLowerCase());
  expect(
    response.headers
      .get("Access-Control-Expose-Headers")
      ?.split(",")
      .map((header) => header.trim().toLowerCase()),
  ).toContain(REQUEST_ID_HEADER);
  expect(response.headers.get(CLAUSE_WARNINGS_HEADER)).toBe("1000000");
  expect(response.headers.get(REQUEST_ID_HEADER)).toBe("req_download");
});

test("cross-origin downloads expose undecided AI conditions", () => {
  expect(CORS_EXPOSED_HEADERS).toContain(UNDECIDED_CONDITIONS_HEADER);
  expect(CORS_EXPOSED_HEADERS).toContain("X-Ai-Field-Errors");
});
