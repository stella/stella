import { afterEach, expect, mock, spyOn, test } from "bun:test";

import { skCourtsDocumentFetch } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { INGESTION_USER_AGENT } from "@/api/lib/case-law/ingestion-user-agent";

afterEach(() => mock.restore());

test("document downloads identify the client and preserve the caller's abort and redirect policy", async () => {
  const response = new Response("%PDF-", {
    headers: { "Content-Type": "application/octet-stream" },
  });
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(response);
  const controller = new AbortController();
  expect(
    await skCourtsDocumentFetch(
      "https://obcan.justice.sk/content/public/item/fixture-document",
      { signal: controller.signal },
    ),
  ).toBe(response);
  expect(fetch).toHaveBeenCalledTimes(1);
  const call = fetch.mock.calls.at(0);
  expect(call).toBeDefined();
  const [, init] = call ?? [];
  expect(new Headers(init?.headers).get("user-agent")).toBe(
    INGESTION_USER_AGENT,
  );
  expect(init?.redirect).toBe("error");
  controller.abort();
  expect(init?.signal?.aborted).toBe(true);
});
