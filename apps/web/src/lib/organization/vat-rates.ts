import { infiniteQueryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import type { VatRatePresetCountry } from "@stll/api-contract";

import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import type { IdempotentRequest } from "@/lib/idempotency/use-idempotent-submit";
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
  | { type: "archive"; id: string }
  | { type: "applyPreset"; country: VatRatePresetCountry };
export const sendVatRateCommand = async (
  command: VatRateCommand,
  intentRequest: IdempotentRequest,
) => {
  if (command.type === "create") {
    return invokeCapability("vat-rates.create", async (capability) =>
      unwrapApiResponse(
        await api["vat-rates"].post(command.values, {
          ...capability,
          fetch: { headers: intentRequest.headers },
        }),
      ),
    );
  }
  if (command.type === "applyPreset") {
    return invokeCapability("vat-rates.presets.create", async (request) =>
      unwrapApiResponse(
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
        unwrapApiResponse(await rate.patch(command.values, request)),
      );
    case "archive":
      return invokeCapability("vat-rates.archive", async (request) =>
        unwrapApiResponse(await rate.archive.post(undefined, request)),
      );
    default:
      command satisfies never;
      return panic("Unexpected VAT rate command");
  }
};
