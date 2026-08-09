import {
  parsePolishedTimeEntryNarrativeResponse,
  parseApiErrorValue,
  parseTimeEntryDeleteResponse,
  parseTimeEntryIdResponse,
  parseTimeEntryListPage,
  parseTimeEntrySplitResponse,
  parseTimeEntrySummary,
  parseTimeEntryUpdatedResponse,
  parseTimerStartResponse,
  parseTimerStopResponse,
} from "@stll/api-contract";
import type { TimeEntryListPage, TimeEntrySummary } from "@stll/api-contract";

import {
  getApiRequestHeaders,
  waitForSimulatedApiDelay,
} from "@/lib/api-request-context";
import { apiUrl } from "@/lib/api-url";
import { toAPIError } from "@/lib/errors/api";
import { fetchWithTimeout } from "@/lib/fetch";

const TIME_ENTRY_REQUEST_TIMEOUT_MS = 30_000;

type TimeEntryQueryValue = boolean | number | string | undefined;

type TimeEntryRequestOptions<T> = {
  body?: unknown;
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  parse: (input: unknown) => T | null;
  path: `/${string}`;
  query?: Record<string, TimeEntryQueryValue>;
  signal?: AbortSignal | undefined;
  workspaceId: string;
};

const requestTimeEntries = async <T>({
  body,
  method = "GET",
  parse,
  path,
  query,
  signal,
  workspaceId,
}: TimeEntryRequestOptions<T>): Promise<T> => {
  await waitForSimulatedApiDelay();
  const url = new URL(
    apiUrl(`/time-entries/${encodeURIComponent(workspaceId)}${path}`),
  );
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  const response = await fetchWithTimeout(url, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: "include",
    headers: {
      ...getApiRequestHeaders(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    method,
    signal,
    timeoutMs: TIME_ENTRY_REQUEST_TIMEOUT_MS,
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw toAPIError({
      status: response.status,
      value: parseApiErrorValue(payload),
    });
  }
  const parsed = parse(await response.json());
  if (parsed === null) {
    throw toAPIError({ status: 502, value: null });
  }
  return parsed;
};

type FetchTimeEntriesOptions = {
  query: Record<string, TimeEntryQueryValue>;
  signal?: AbortSignal | undefined;
  workspaceId: string;
};

export const fetchTimeEntries = ({
  query,
  signal,
  workspaceId,
}: FetchTimeEntriesOptions): Promise<TimeEntryListPage> =>
  requestTimeEntries({
    parse: parseTimeEntryListPage,
    path: "/",
    query,
    signal,
    workspaceId,
  });

export const fetchTimeEntrySummary = ({
  query,
  signal,
  workspaceId,
}: FetchTimeEntriesOptions): Promise<TimeEntrySummary> =>
  requestTimeEntries({
    parse: parseTimeEntrySummary,
    path: "/summary",
    query,
    signal,
    workspaceId,
  });

type TimeEntryMutation =
  | { body: unknown; type: "create" }
  | { body: unknown; type: "update" }
  | { body: unknown; type: "delete" }
  | { body: unknown; type: "timer_start" }
  | { body: unknown; type: "timer_stop" }
  | { body: unknown; type: "batch_update" }
  | { body: unknown; type: "batch_delete" }
  | { body: unknown; type: "split" };

type SendTimeEntryMutationOptions = {
  mutation: TimeEntryMutation;
  workspaceId: string;
};

export const sendTimeEntryMutation = async ({
  mutation,
  workspaceId,
}: SendTimeEntryMutationOptions): Promise<void> => {
  switch (mutation.type) {
    case "create":
      await requestTimeEntries({
        body: mutation.body,
        method: "PUT",
        parse: parseTimeEntryIdResponse,
        path: "/",
        workspaceId,
      });
      return;
    case "update":
      await requestTimeEntries({
        body: mutation.body,
        method: "PATCH",
        parse: parseTimeEntryIdResponse,
        path: "/",
        workspaceId,
      });
      return;
    case "delete":
      await requestTimeEntries({
        body: mutation.body,
        method: "DELETE",
        parse: parseTimeEntryDeleteResponse,
        path: "/",
        workspaceId,
      });
      return;
    case "timer_start":
      await requestTimeEntries({
        body: mutation.body,
        method: "POST",
        parse: parseTimerStartResponse,
        path: "/timer/start",
        workspaceId,
      });
      return;
    case "timer_stop":
      await requestTimeEntries({
        body: mutation.body,
        method: "POST",
        parse: parseTimerStopResponse,
        path: "/timer/stop",
        workspaceId,
      });
      return;
    case "batch_update":
      await requestTimeEntries({
        body: mutation.body,
        method: "POST",
        parse: parseTimeEntryUpdatedResponse,
        path: "/batch",
        workspaceId,
      });
      return;
    case "batch_delete":
      await requestTimeEntries({
        body: mutation.body,
        method: "DELETE",
        parse: parseTimeEntryUpdatedResponse,
        path: "/batch",
        workspaceId,
      });
      return;
    case "split":
      await requestTimeEntries({
        body: mutation.body,
        method: "POST",
        parse: parseTimeEntrySplitResponse,
        path: "/split",
        workspaceId,
      });
      return;
    default: {
      const exhaustive: never = mutation;
      return exhaustive;
    }
  }
};

type PolishTimeEntryNarrativeOptions = {
  instruction: string;
  narrative: string;
  workspaceId: string;
};

export const polishTimeEntryNarrative = ({
  instruction,
  narrative,
  workspaceId,
}: PolishTimeEntryNarrativeOptions): Promise<{ narrative: string }> =>
  requestTimeEntries({
    body: { instruction, narrative },
    method: "POST",
    parse: parsePolishedTimeEntryNarrativeResponse,
    path: "/polish-narrative",
    workspaceId,
  });
