import { infiniteQueryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";

export const vatRatesKeys = {
  all: (organizationId: string) => ["vat-rates", organizationId] as const,
};
const listVatRates = async (cursor: string | undefined, signal: AbortSignal) =>
  unwrapEden(
    await api["vat-rates"].get({
      query: { ...(cursor === undefined ? {} : { cursor }) },
      fetch: { signal },
    }),
  );
export const vatRatesOptions = (organizationId: string) =>
  infiniteQueryOptions({
    queryKey: vatRatesKeys.all(organizationId),
    initialPageParam: stringCursorSeed(),
    queryFn: ({ pageParam, signal }) => listVatRates(pageParam, signal),
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
    return unwrapEden(await api["vat-rates"].post(command.values));
  }
  const rate = api["vat-rates"]({ vatRateId: toSafeId<"vatRate">(command.id) });
  switch (command.type) {
    case "update":
      return unwrapEden(await rate.patch(command.values));
    case "archive":
      return unwrapEden(await rate.archive.post());
  }
};
