import { infiniteQueryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";

export const vatRatesKeys = {
  all: (organizationId: string) => ["vat-rates", organizationId] as const,
};
const listVatRates = async (cursor: string | undefined, signal: AbortSignal) =>
  unwrapApiResponse(
    await api["vat-rates"].get({
      query: { ...(cursor === undefined ? {} : { cursor }) },
      fetch: { signal },
    }),
  );
export const vatRatesOptions = (organizationId: string) =>
  infiniteQueryOptions({
    queryKey: vatRatesKeys.all(organizationId),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) => listVatRates(pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
export type VatRate = Awaited<ReturnType<typeof listVatRates>>["items"][number];
export type VatRateInput = Parameters<(typeof api)["vat-rates"]["post"]>[0];
export type VatRateCommand =
  | { type: "create"; values: VatRateInput }
  | { type: "update"; id: string; values: VatRateInput }
  | { type: "archive"; id: string };
export const sendVatRateCommand = async (command: VatRateCommand) => {
  if (command.type === "create") {
    return unwrapApiResponse(await api["vat-rates"].post(command.values));
  }
  const rate = api["vat-rates"]({ vatRateId: toSafeId<"vatRate">(command.id) });
  switch (command.type) {
    case "update":
      return unwrapApiResponse(await rate.patch(command.values));
    case "archive":
      return unwrapApiResponse(await rate.archive.post());
    default:
      command satisfies never;
      return panic("Unexpected VAT rate command");
  }
};
