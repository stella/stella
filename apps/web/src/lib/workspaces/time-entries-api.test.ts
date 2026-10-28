import { afterAll, beforeEach, expect, mock, test } from "bun:test";

import { APIError } from "@/lib/errors/api";

import {
  createTimeEntry,
  type CreateTimeEntryBody,
  decideTimeSuggestion,
  fetchTimeEntries,
  fetchTimeEntrySummary,
  updateTimeEntry,
} from "./time-entries-api";

const originalFetch = globalThis.fetch;
const requests: { body: unknown; method: string }[] = [];
let responses: unknown[] = [];

beforeEach(() => {
  requests.length = 0;
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
