import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";

export const numberSeriesKeys = {
  all: (organizationId: string) => ["number-series", organizationId] as const,
  preview: ({
    organizationId,
    id,
    date,
  }: {
    organizationId: string;
    id: string;
    date: string;
  }) => [...numberSeriesKeys.all(organizationId), "preview", id, date] as const,
};

const listNumberSeries = async (
  cursor: string | undefined,
  signal: AbortSignal,
) =>
  unwrapEden(
    await api["number-series"].get({
      query: { ...(cursor === undefined ? {} : { cursor }) },
      fetch: { signal },
    }),
  );

export const numberSeriesOptions = (organizationId: string) =>
  infiniteQueryOptions({
    queryKey: numberSeriesKeys.all(organizationId),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) =>
      listNumberSeries(pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

type NumberSeriesPreviewOptions = {
  organizationId: string;
  id: string;
  date: string;
};

const getNumberSeriesPreview = async (
  options: NumberSeriesPreviewOptions,
  signal: AbortSignal,
) => {
  const result = unwrapEden(
    await api["number-series"]({
      numberSeriesId: toSafeId<"numberSeries">(options.id),
    }).preview.get({ query: { issueDate: options.date }, fetch: { signal } }),
  );
  const { availability } = result;
  if (availability !== "available" && availability !== "already_allocated") {
    panic("Unexpected number series preview availability");
  }
  return { ...result, availability };
};

export const numberSeriesPreviewOptions = (
  options: NumberSeriesPreviewOptions,
) =>
  queryOptions({
    queryKey: numberSeriesKeys.preview(options),
    queryFn: async ({ signal }) => getNumberSeriesPreview(options, signal),
  });
export type NumberSeriesPreviewData = Awaited<
  ReturnType<typeof getNumberSeriesPreview>
>;

export type NumberSeries = Awaited<
  ReturnType<typeof listNumberSeries>
>["items"][number];
export type NumberSeriesInput = Parameters<
  (typeof api)["number-series"]["post"]
>[0];
type NumberSeriesPatch = Parameters<
  ReturnType<(typeof api)["number-series"]>["patch"]
>[0];
export type NumberSeriesCommand =
  | { type: "create"; values: NumberSeriesInput }
  | { type: "update"; id: string; values: NumberSeriesPatch }
  | { type: "default"; id: string }
  | { type: "archive"; id: string };

export const sendNumberSeriesCommand = async (command: NumberSeriesCommand) => {
  if (command.type === "create") {
    return unwrapEden(await api["number-series"].post(command.values));
  }
  const series = api["number-series"]({
    numberSeriesId: toSafeId<"numberSeries">(command.id),
  });
  switch (command.type) {
    case "update":
      return unwrapEden(await series.patch(command.values));
    case "default":
      return unwrapEden(await series.default.post());
    case "archive":
      return unwrapEden(await series.archive.post());
  }
};
