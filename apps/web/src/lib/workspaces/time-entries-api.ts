import type {
  TimeEntry,
  TimeEntryListPage,
} from "@stll/api-contract/time-entries";
import { cents } from "@stll/money";
import type { CentsAmount } from "@stll/money";

import { api } from "@/lib/api";
import type { WebApiRoutes } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";

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
  const page = unwrapApiResponse(
    await timeEntriesRoute(workspaceId).get({
      query,
      ...(signal === undefined ? {} : { fetch: { signal } }),
    }),
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
  unwrapApiResponse(
    await timeEntriesRoute(workspaceId).summary.get({
      query,
      ...(signal === undefined ? {} : { fetch: { signal } }),
    }),
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
  unwrapApiResponse(
    await timeEntriesRoute(workspaceId).suggestions.get({
      query,
      ...(signal === undefined ? {} : { fetch: { signal } }),
    }),
  );

export type CreateTimeEntryBody = TimeEntryRoutes["put"]["body"];

export const createTimeEntry = async (
  workspaceId: string,
  body: CreateTimeEntryBody,
) => unwrapApiResponse(await timeEntriesRoute(workspaceId).put(body));

export type UpdateTimeEntryBody = TimeEntryRoutes["patch"]["body"];

export const updateTimeEntry = async (
  workspaceId: string,
  body: UpdateTimeEntryBody,
) => unwrapApiResponse(await timeEntriesRoute(workspaceId).patch(body));

export const deleteTimeEntry = async (workspaceId: string, id: string) =>
  unwrapApiResponse(await timeEntriesRoute(workspaceId).delete({ id }));

export const batchUpdateTimeEntries = async (
  workspaceId: string,
  body: TimeEntryRoutes["batch"]["post"]["body"],
) => unwrapApiResponse(await timeEntriesRoute(workspaceId).batch.post(body));

export const batchDeleteTimeEntries = async (
  workspaceId: string,
  ids: string[],
) =>
  unwrapApiResponse(await timeEntriesRoute(workspaceId).batch.delete({ ids }));

export const splitTimeEntry = async (
  workspaceId: string,
  body: TimeEntryRoutes["split"]["post"]["body"],
) => unwrapApiResponse(await timeEntriesRoute(workspaceId).split.post(body));

export type TimeSuggestionDecisionBody =
  TimeEntryRoutes["suggestions"]["decisions"]["post"]["body"];

export const decideTimeSuggestion = async (
  workspaceId: string,
  body: TimeSuggestionDecisionBody,
) =>
  unwrapApiResponse(
    await timeEntriesRoute(workspaceId).suggestions.decisions.post(body),
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
  unwrapApiResponse(
    await timeEntriesRoute(workspaceId)["polish-narrative"].post({
      instruction,
      narrative,
    }),
  );

/** Approves entries across the organization's matters in one call. */
export const approveTimeEntries = async (ids: readonly string[]) =>
  await invokeCapability(
    "time-entries.approval-queue.approve",
    async (request) =>
      unwrapApiResponse(
        await api["time-entries"].approve.post({ ids: [...ids] }, request),
      ),
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
    async (request) =>
      unwrapApiResponse(
        await api["time-entries"]["approval-queue"].return.post(
          { comment, ids: [...ids] },
          request,
        ),
      ),
  );
