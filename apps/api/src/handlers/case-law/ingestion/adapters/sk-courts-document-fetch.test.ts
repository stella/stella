import { Result } from "better-result";
import { afterEach, expect, mock, spyOn, test } from "bun:test";

import {
  DOCUMENT_FETCH_EVENT,
  type DocumentStageObservation,
} from "@stll/legal-atlas/document-fetch-diagnostics";

import { skCourtsDocumentFetch } from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { INGESTION_USER_AGENT } from "@/api/lib/case-law/ingestion-user-agent";
import { withDocumentStageWindow } from "@/api/lib/legal-search/document-stage-observation";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { SkDocumentNonPdfError } from "@/api/lib/legal-search/sk-document-fetch-diagnostics";

afterEach(() => mock.restore());

test("the deferred Slovak fetch emits typed document outcomes through the shared boundary", async () => {
  const observations: DocumentStageObservation[] = [];
  spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("challenge", { headers: { "content-type": "text/html" } }),
  );
  await withDocumentStageWindow({
    source: ADAPTER_KEYS.SK_COURTS,
    now: () => 0,
    observe: (event) => {
      observations.push(event);
    },
    fetchPage: async () => {
      await skCourtsDocumentFetch(
        new URL(
          "https://obcan.justice.sk/content/public/item/fixture-document",
        ),
        { signal: new AbortController().signal },
      );
      return Result.err(
        new SkDocumentNonPdfError({
          adapterKey: ADAPTER_KEYS.SK_COURTS,
          cursor: null,
          message: "fixture",
        }),
      );
    },
  });
  expect(observations).toEqual([
    {
      event: DOCUMENT_FETCH_EVENT.fetchOutcome,
      source: ADAPTER_KEYS.SK_COURTS,
      outcome: "body_shape",
      http_status: 200,
    },
    {
      event: DOCUMENT_FETCH_EVENT.window,
      aggregation: "page",
      source: ADAPTER_KEYS.SK_COURTS,
      backlog: 1,
      attempted: 1,
      filled: 0,
      failed: 1,
      window_seconds: 0,
    },
  ]);
});

test("document downloads identify the client and preserve the caller's abort and redirect policy", async () => {
  const response = new Response("%PDF-", {
    headers: { "Content-Type": "application/octet-stream" },
  });
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(response);
  const controller = new AbortController();
  const read = await skCourtsDocumentFetch(
    new URL("https://obcan.justice.sk/content/public/item/fixture-document"),
    { signal: controller.signal },
  );
  expect(read.type === "present" ? read.value : read).toBe(response);
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

test("a document the publisher cannot serve is typed by what the request established", async () => {
  const url = new URL(
    "https://obcan.justice.sk/content/public/item/fixture-document",
  );
  const signal = new AbortController().signal;
  for (const [answer, expected] of [
    [
      new Response(null, { status: 404 }),
      { type: "absent", evidence: "http-404" },
    ],
    [
      new Response(null, { status: 204 }),
      { type: "unavailable", cause: { kind: "no-content", status: 204 } },
    ],
    [
      new Response("", { status: 503 }),
      { type: "unavailable", cause: { kind: "status", status: 503 } },
    ],
  ] as const) {
    spyOn(globalThis, "fetch").mockResolvedValue(answer);
    expect(await skCourtsDocumentFetch(url, { signal })).toEqual(expected);
    mock.restore();
  }
  expect(
    await skCourtsDocumentFetch(new URL("https://example.invalid/document"), {
      signal,
    }),
  ).toMatchObject({ type: "refused-target" });
});
