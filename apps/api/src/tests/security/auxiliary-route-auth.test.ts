import { expect, test } from "bun:test";

import api from "@/api/server";

test("composed icon and chart routes reject unauthenticated callers", async () => {
  const icon = await api.handle(
    new Request("http://localhost/v1/chat/link-icons/example.com"),
  );
  expect(icon.status).toBe(401);
  const chart = await api.handle(
    new Request("http://localhost/v1/chat/table-chart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(chart.status).toBe(401);
});

test("account data export routes require an authenticated account", async () => {
  const create = await api.handle(
    new Request("http://localhost/v1/me/data-exports/", { method: "POST" }),
  );
  expect(create.status).toBe(401);
  const list = await api.handle(
    new Request("http://localhost/v1/me/data-exports/"),
  );
  expect(list.status).toBe(401);
  const detail = await api.handle(
    new Request(
      "http://localhost/v1/me/data-exports/0198c0de-0000-4000-8000-000000000000",
    ),
  );
  expect(detail.status).toBe(401);
  const download = await api.handle(
    new Request(
      "http://localhost/v1/me/data-exports/0198c0de-0000-4000-8000-000000000000/download",
    ),
  );
  expect(download.status).toBe(401);
});

test("composed collaboration seed rejects absent room credentials", async () => {
  const response = await api.handle(
    new Request("http://localhost/v1/folio-collab-rooms/snapshot/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    message: "Collaborative editing room not found.",
  });
});
