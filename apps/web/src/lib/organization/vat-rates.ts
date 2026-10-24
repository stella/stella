import { infiniteQueryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import type { VatRatePresetCountry } from "@stll/api-contract";

import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
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
    queryFn: async ({ pageParam, signal }) => listVatRates(pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
export type VatRate = Awaited<ReturnType<typeof listVatRates>>["items"][number];
export type VatRateInput = Parameters<(typeof api)["vat-rates"]["post"]>[0];
export type VatRateCommand =
  | { type: "create"; values: VatRateInput }
  | { type: "update"; id: string; values: VatRateInput }
  | { type: "archive"; id: string }
  | { type: "applyPreset"; country: VatRatePresetCountry };
export const sendVatRateCommand = async (command: VatRateCommand) => {
  if (command.type === "create") {
    return invokeCapability("vat-rates.create", async (request) =>
      unwrapEden(await api["vat-rates"].post(command.values, request)),
    );
  }
  if (command.type === "applyPreset") {
    return invokeCapability("vat-rates.presets.create", async (request) =>
      unwrapEden(
        await api["vat-rates"]["apply-preset"].post(
          { country: command.country },
          request,
        ),
      ),
    );
  }
  const rate = api["vat-rates"]({ vatRateId: toSafeId<"vatRate">(command.id) });
  switch (command.type) {
    case "update":
      return invokeCapability("vat-rates.update", async (request) =>
        unwrapEden(await rate.patch(command.values, request)),
      );
    case "archive":
      return invokeCapability("vat-rates.archive", async (request) =>
        unwrapEden(await rate.archive.post(undefined, request)),
      );
    default:
      command satisfies never;
      return panic("Unexpected VAT rate command");
  }
};
