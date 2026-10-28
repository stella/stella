import { afterAll, beforeEach, expect, mock, test } from "bun:test";

import {
  createTimeEntry,
  type CreateTimeEntryBody,
  decideTimeSuggestion,
  updateTimeEntry,
} from "./time-entries-api";

const originalFetch = globalThis.fetch;
const requests: { body: unknown; method: string }[] = [];

beforeEach(() => {
  requests.length = 0;
  globalThis.fetch = Object.assign(
    mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        method: init?.method ?? "GET",
      });
      return new Response(
        JSON.stringify({ id: "entry-1", status: "accepted" }),
        {
          headers: { "content-type": "application/json" },
          status: 200,
        },
      );
    }),
    { preconnect: originalFetch.preconnect },
  );
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
