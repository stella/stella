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
  rateAtEntry: CentsAmount;
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
    items: page.items.map((entry) => ({
      ...entry,
      rateAtEntry: cents(entry.rateAtEntry),
    })),
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

export type CreateTimeEntryBody = TimeEntryRoutes["put"]["body"];

export const createTimeEntry = async (
  workspaceId: string,
  body: CreateTimeEntryBody,
) =>
  parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).put(body),
    timeEntryResponseParsers.create,
  );

export type UpdateTimeEntryBody = TimeEntryRoutes["patch"]["body"];

export const updateTimeEntry = async (
  workspaceId: string,
  body: UpdateTimeEntryBody,
) =>
  parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).patch(body),
    timeEntryResponseParsers.update,
  );

export const deleteTimeEntry = async (workspaceId: string, id: string) =>
  parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).delete({ id }),
    timeEntryResponseParsers.delete,
  );

export const batchUpdateTimeEntries = async (
  workspaceId: string,
  body: TimeEntryRoutes["batch"]["post"]["body"],
) =>
  parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).batch.post(body),
    timeEntryResponseParsers.batchUpdate,
  );

export const batchDeleteTimeEntries = async (
  workspaceId: string,
  ids: string[],
) =>
  parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).batch.delete({ ids }),
    timeEntryResponseParsers.batchDelete,
  );

export const splitTimeEntry = async (
  workspaceId: string,
  body: TimeEntryRoutes["split"]["post"]["body"],
) =>
  parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).split.post(body),
    timeEntryResponseParsers.split,
  );

export type TimeSuggestionDecisionBody =
  TimeEntryRoutes["suggestions"]["decisions"]["post"]["body"];

export const decideTimeSuggestion = async (
  workspaceId: string,
  body: TimeSuggestionDecisionBody,
) =>
  parseTimeEntryResponse(
    await timeEntriesRoute(workspaceId).suggestions.decisions.post(body),
    timeEntryResponseParsers.decideSuggestion,
  );

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
