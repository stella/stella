import type { ExactRequestBody } from "@stll/api-client";
import {
  parsePolishedTimeEntryNarrativeResponse,
  parseTimeApprovalBatch,
  parseTimeEntryDeleteResponse,
  parseTimeEntryIdResponse,
  parseTimeEntryListPage,
  parseTimeEntrySplitResponse,
  parseTimeEntrySuggestionDecision,
  parseTimeEntrySuggestionsResponse,
  parseTimeEntrySummary,
  parseTimeEntryUpdatedResponse,
  parseTimeReturnBatch,
  type TimeEntry,
  type TimeEntryListPage,
} from "@stll/api-contract/time-entries";
import { cents } from "@stll/money";
import type { CentsAmount } from "@stll/money";

import { api } from "@/lib/api";
import type { WebApiRoutes } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { toAPIError, unwrapApiResponse } from "@/lib/errors/api";
import type { ApiResponse } from "@/lib/errors/api";

const timeEntryResponseParsers = {
  approve: parseTimeApprovalBatch,
  batchDelete: parseTimeEntryUpdatedResponse,
  batchUpdate: parseTimeEntryUpdatedResponse,
  create: parseTimeEntryIdResponse,
  decideSuggestion: parseTimeEntrySuggestionDecision,
  delete: parseTimeEntryDeleteResponse,
  list: parseTimeEntryListPage,
  polishNarrative: parsePolishedTimeEntryNarrativeResponse,
  return: parseTimeReturnBatch,
  split: parseTimeEntrySplitResponse,
  suggestions: parseTimeEntrySuggestionsResponse,
  summary: parseTimeEntrySummary,
  update: parseTimeEntryIdResponse,
} as const;

const parseTimeEntryResponse = <T>(
  response: ApiResponse<unknown>,
  parser: (input: unknown) => T | null,
): T => {
  const parsed = parser(unwrapApiResponse(response));
  if (parsed === null) {
    throw toAPIError({ status: 502, value: null });
  }
  return parsed;
};

const timeEntriesRoute = (workspaceId: string) =>
  api["time-entries"]({ workspaceId });

// Request bodies are the API's own route schemas, so a field the API does
// not accept cannot be sent.
type TimeEntryRoutes = WebApiRoutes["time-entries"][":workspaceId"];

type TimeEntriesQuery = {
  limit?: number;
  cursor?: string;
  userId?: string;
  scope?: "me";
  workItemId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: "approved" | "billed" | "draft" | "submitted" | "written_off";
  source?: "activity" | "manual" | "suggested" | "timer";
  billable?: boolean;
  hasActiveTimer?: boolean;
};

type BrowserTimeEntry = Omit<TimeEntry, "rateAtEntry"> & {
  rateAtEntry: CentsAmount | null;
};

type BrowserTimeEntryListPage = Omit<TimeEntryListPage, "items"> & {
  items: BrowserTimeEntry[];
};

type FetchTimeEntriesOptions = {
  query: TimeEntriesQuery;
  signal?: AbortSignal | undefined;
  workspaceId: string;
};

export const fetchTimeEntries = async ({
  query,
  signal,
  workspaceId,
}: FetchTimeEntriesOptions): Promise<BrowserTimeEntryListPage> => {
  const page = parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).get({
      query,
      ...(signal === undefined ? {} : { fetch: { signal } }),
    }),
    timeEntryResponseParsers.list,
  );
  return {
    ...page,
    items: page.items.map((entry) =>
      Object.assign(entry, {
        rateAtEntry:
          entry.rateAtEntry === null ? null : cents(entry.rateAtEntry),
      }),
    ),
  };
};

type FetchTimeEntrySummaryOptions = {
  query: { dateFrom: string; dateTo: string; scope?: "team" };
  signal?: AbortSignal | undefined;
  workspaceId: string;
};

export const fetchTimeEntrySummary = async ({
  query,
  signal,
  workspaceId,
}: FetchTimeEntrySummaryOptions) =>
  parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).summary.get({
      query,
      ...(signal === undefined ? {} : { fetch: { signal } }),
    }),
    timeEntryResponseParsers.summary,
  );

type FetchTimeEntrySuggestionsOptions = {
  query: { date: string; timezoneId: string };
  signal?: AbortSignal | undefined;
  workspaceId: string;
};

export const fetchTimeEntrySuggestions = async ({
  query,
  signal,
  workspaceId,
}: FetchTimeEntrySuggestionsOptions) =>
  parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).suggestions.get({
      query,
      ...(signal === undefined ? {} : { fetch: { signal } }),
    }),
    timeEntryResponseParsers.suggestions,
  );

type TimeEntryWrite<
  TBody,
  TOperation extends keyof typeof timeEntryResponseParsers,
> = <TActual extends TBody>(
  workspaceId: string,
  body: ExactRequestBody<TBody, TActual>,
) => Promise<
  NonNullable<ReturnType<(typeof timeEntryResponseParsers)[TOperation]>>
>;

export type CreateTimeEntryBody = TimeEntryRoutes["put"]["body"];

export const createTimeEntry: TimeEntryWrite<
  CreateTimeEntryBody,
  "create"
> = async (workspaceId, body) => {
  const requestBody: CreateTimeEntryBody = body;
  return parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).put(requestBody),
    timeEntryResponseParsers.create,
  );
};

export type UpdateTimeEntryBody = TimeEntryRoutes["patch"]["body"];

export const updateTimeEntry: TimeEntryWrite<
  UpdateTimeEntryBody,
  "update"
> = async (workspaceId, body) => {
  const requestBody: UpdateTimeEntryBody = body;
  return parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).patch(requestBody),
    timeEntryResponseParsers.update,
  );
};

export const deleteTimeEntry = async (workspaceId: string, id: string) =>
  parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).delete({ id }),
    timeEntryResponseParsers.delete,
  );

type BatchUpdateTimeEntryBody = TimeEntryRoutes["batch"]["post"]["body"];

export const batchUpdateTimeEntries: TimeEntryWrite<
  BatchUpdateTimeEntryBody,
  "batchUpdate"
> = async (workspaceId, body) => {
  const requestBody: BatchUpdateTimeEntryBody = body;
  return parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).batch.post(requestBody),
    timeEntryResponseParsers.batchUpdate,
  );
};

export const batchDeleteTimeEntries = async (
  workspaceId: string,
  ids: string[],
) =>
  parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).batch.delete({ ids }),
    timeEntryResponseParsers.batchDelete,
  );

type SplitTimeEntryBody = TimeEntryRoutes["split"]["post"]["body"];

export const splitTimeEntry: TimeEntryWrite<
  SplitTimeEntryBody,
  "split"
> = async (workspaceId, body) => {
  const requestBody: SplitTimeEntryBody = body;
  return parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).split.post(requestBody),
    timeEntryResponseParsers.split,
  );
};

export type TimeSuggestionDecisionBody =
  TimeEntryRoutes["suggestions"]["decisions"]["post"]["body"];

export const decideTimeSuggestion: TimeEntryWrite<
  TimeSuggestionDecisionBody,
  "decideSuggestion"
> = async (workspaceId, body) => {
  const requestBody: TimeSuggestionDecisionBody = body;
  return parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).suggestions.decisions.post(requestBody),
    timeEntryResponseParsers.decideSuggestion,
  );
};

type PolishTimeEntryNarrativeOptions = {
  instruction: string;
  narrative: string;
  workspaceId: string;
};

export const polishTimeEntryNarrative = async ({
  instruction,
  narrative,
  workspaceId,
}: PolishTimeEntryNarrativeOptions) =>
  parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId)["polish-narrative"].post({
      instruction,
      narrative,
    }),
    timeEntryResponseParsers.polishNarrative,
  );

/** Approves entries across the organization's matters in one call. */
export const approveTimeEntries = async (ids: readonly string[]) =>
  await invokeCapability(
    "time-entries.approval-queue.approve",
    async (request) => {
      const response = await api["time-entries"].approve.post(
        { ids: [...ids] },
        request,
      );
      if (response.error) {
        throw toAPIError(response.error);
      }
      return parseTimeEntryResponse(response, timeEntryResponseParsers.approve);
    },
  );

/** Returns entries to their owners with one comment in one call. */
export const returnTimeEntries = async ({
  comment,
  ids,
}: {
  comment: string;
  ids: readonly string[];
}) =>
  await invokeCapability(
    "time-entries.approval-queue.return",
    async (request) => {
      const response = await api["time-entries"]["approval-queue"].return.post(
        { comment, ids: [...ids] },
        request,
      );
      if (response.error) {
        throw toAPIError(response.error);
      }
      return parseTimeEntryResponse(response, timeEntryResponseParsers.return);
    },
  );
