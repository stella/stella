import { afterAll, beforeEach, expect, mock, test } from "bun:test";

import { APIError } from "@/lib/errors/api";

import {
  batchDeleteTimeEntries,
  batchUpdateTimeEntries,
  createTimeEntry,
  type CreateTimeEntryBody,
  decideTimeSuggestion,
  deleteTimeEntry,
  fetchTimeEntries,
  fetchTimeEntrySummary,
  splitTimeEntry,
  updateTimeEntry,
} from "./time-entries-api";

const originalFetch = globalThis.fetch;
const requests: { body: unknown; method: string }[] = [];
let responses: unknown[] = [];
const transportRequests: { url: string; method: string; headers: Headers }[] =
  [];

beforeEach(() => {
  requests.length = 0;
  transportRequests.length = 0;
  responses = [
    { id: "entry-1" },
    { id: "entry-1" },
    {
      fingerprint: "suggestion-1",
      status: "dismissed",
      timeEntryId: null,
    },
  ];
  globalThis.fetch = Object.assign(
    mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      transportRequests.push({
        url: _input instanceof Request ? _input.url : String(_input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
      });
      requests.push({
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        method: init?.method ?? "GET",
      });
      return new Response(JSON.stringify(responses.shift()), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    }),
    { preconnect: originalFetch.preconnect },
  );
});

test.each([
  [
    "list",
    async () => fetchTimeEntries({ query: {}, workspaceId: "workspace-1" }),
  ],
  [
    "summary",
    async () =>
      fetchTimeEntrySummary({
        query: { dateFrom: "2026-10-01", dateTo: "2026-10-31" },
        workspaceId: "workspace-1",
      }),
  ],
  [
    "create",
    async () =>
      createTimeEntry("workspace-1", {
        dateWorked: "2026-10-28",
        timezoneId: "Etc/UTC",
        durationMinutes: 30,
        narrative: "Drafted motion",
        billable: true,
      }),
  ],
  [
    "update",
    async () =>
      updateTimeEntry("workspace-1", { id: "entry-1", narrative: "Bad" }),
  ],
] as const)(
  "rejects a malformed %s response as a bad gateway",
  async (_name, call) => {
    responses = [{ malformed: true }];
    try {
      await call();
      throw new Error("Expected malformed response to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(APIError);
      expect(error).toMatchObject({ status: 502 });
    }
  },
);

test("a batch delete accepts the batch count answer", async () => {
  responses = [{ updated: 2 }];
  expect(
    await batchDeleteTimeEntries("workspace-1", ["entry-1", "entry-2"]),
  ).toEqual({ updated: 2 });
  expect(requests).toEqual([
    { body: { ids: ["entry-1", "entry-2"] }, method: "DELETE" },
  ]);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

test("time-entry mutations send only route-schema fields", async () => {
  await createTimeEntry("workspace-1", {
    dateWorked: "2026-10-28",
    timezoneId: "Etc/UTC",
    durationMinutes: 30,
    narrative: "Drafted motion",
    billable: true,
  });
  await updateTimeEntry("workspace-1", {
    id: "entry-1",
    narrative: "Revised motion",
  });
  await decideTimeSuggestion("workspace-1", {
    fingerprint: "suggestion-1",
    date: "2026-10-28",
    timezoneId: "Etc/UTC",
    decision: { type: "dismiss" },
  });

  expect(requests).toEqual([
    {
      method: "PUT",
      body: {
        dateWorked: "2026-10-28",
        timezoneId: "Etc/UTC",
        durationMinutes: 30,
        narrative: "Drafted motion",
        billable: true,
      },
    },
    {
      method: "PATCH",
      body: { id: "entry-1", narrative: "Revised motion" },
    },
    {
      method: "POST",
      body: {
        fingerprint: "suggestion-1",
        date: "2026-10-28",
        timezoneId: "Etc/UTC",
        decision: { type: "dismiss" },
      },
    },
  ]);
});

// Cache metadata is not part of the API's create schema, so a body carrying a
// query key does not type-check.
const createBodyOmitsCacheMetadata: "queryKey" extends keyof CreateTimeEntryBody
  ? false
  : true = true;
void createBodyOmitsCacheMetadata;

const cases = [
  {
    name: "create",
    method: "PUT",
    path: "/time-entries/matter",
    response: { id: "entry" },
    send: async () =>
      await createTimeEntry("matter", {
        dateWorked: "2026-10-29",
        timezoneId: "UTC",
        durationMinutes: 30,
        narrative: "Review documents",
        billable: true,
      }),
  },
  {
    name: "update",
    method: "PATCH",
    path: "/time-entries/matter",
    response: { id: "entry" },
    send: async () =>
      await updateTimeEntry("matter", { id: "entry", narrative: "Reviewed" }),
  },
  {
    name: "delete",
    method: "DELETE",
    path: "/time-entries/matter",
    response: { deleted: true },
    send: async () => await deleteTimeEntry("matter", "entry"),
  },
  {
    name: "batch update",
    method: "POST",
    path: "/time-entries/matter/batch",
    response: { updated: 1 },
    send: async () =>
      await batchUpdateTimeEntries("matter", {
        ids: ["entry"],
        action: "approve",
      }),
  },
  {
    name: "batch delete",
    method: "DELETE",
    path: "/time-entries/matter/batch",
    response: { updated: 1 },
    send: async () => await batchDeleteTimeEntries("matter", ["entry"]),
  },
  {
    name: "split",
    method: "POST",
    path: "/time-entries/matter/split",
    response: { entryIds: ["split-entry"], splitGroupId: "split-group" },
    send: async () =>
      await splitTimeEntry("matter", {
        id: "entry",
        splits: [{ workItemId: "task", percentage: 100 }],
      }),
  },
  {
    name: "suggestion decision",
    method: "POST",
    path: "/time-entries/matter/suggestions/decisions",
    response: {
      fingerprint: "suggestion",
      status: "dismissed",
      timeEntryId: null,
    },
    send: async () =>
      await decideTimeSuggestion("matter", {
        fingerprint: "suggestion",
        date: "2026-10-29",
        timezoneId: "UTC",
        decision: { type: "dismiss" },
      }),
  },
] as const;

test.each(cases)(
  "$name uses typed transport without an idempotency key",
  async ({ method, path, response, send }) => {
    responses = [response];
    await send();
    expect(transportRequests).toHaveLength(1);
    const request = transportRequests.at(0);
    expect(request?.url).toEndWith(path);
    expect(request?.method).toBe(method);
    expect(request?.headers.has("Idempotency-Key")).toBe(false);
  },
);
