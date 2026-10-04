import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { panic } from "better-result";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { toSafeId } from "@/lib/safe-id";

export const sellerProfilesKeys = {
  all: (organizationId: string) => ["seller-profiles", organizationId] as const,
};

const listSellerProfiles = async (
  cursor: string | undefined,
  signal: AbortSignal,
) =>
  unwrapEden(
    await api["seller-profiles"].get({
      query: { ...(cursor === undefined ? {} : { cursor }) },
      fetch: { signal },
    }),
  );

export const sellerProfilesOptions = (organizationId: string) =>
  infiniteQueryOptions({
    queryKey: sellerProfilesKeys.all(organizationId),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) =>
      listSellerProfiles(pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

export const sellerProfileOptions = ({
  organizationId,
  id,
}: {
  organizationId: string;
  id: string;
}) =>
  queryOptions({
    queryKey: [...sellerProfilesKeys.all(organizationId), "profile", id],
    queryFn: async ({ signal }) =>
      unwrapEden(
        await api["seller-profiles"]({
          sellerProfileId: toSafeId<"sellerProfile">(id),
        }).get({ fetch: { signal } }),
      ),
  });

export type SellerProfile = Awaited<
  ReturnType<typeof listSellerProfiles>
>["items"][number];
export type SellerProfileInput = Parameters<
  (typeof api)["seller-profiles"]["post"]
>[0];

export type SellerProfileCommand =
  | { type: "create"; values: SellerProfileInput }
  | { type: "update"; id: string; values: SellerProfileInput }
  | { type: "default"; id: string }
  | { type: "archive"; id: string };

export const sendSellerProfileCommand = async (
  command: SellerProfileCommand,
) => {
  if (command.type === "create") {
    return unwrapEden(await api["seller-profiles"].post(command.values));
  }
  const profile = api["seller-profiles"]({
    sellerProfileId: toSafeId<"sellerProfile">(command.id),
  });
  switch (command.type) {
    case "update":
      return unwrapEden(
        await profile.patch({
          ...command.values,
          registrationId: command.values.registrationId ?? null,
          vatId: command.values.vatId ?? null,
          addressLine1: command.values.addressLine1 ?? null,
          addressLine2: command.values.addressLine2 ?? null,
          city: command.values.city ?? null,
          postalCode: command.values.postalCode ?? null,
          country: command.values.country ?? null,
          iban: command.values.iban ?? null,
          bic: command.values.bic ?? null,
          accountNumber: command.values.accountNumber ?? null,
          footerNotes: command.values.footerNotes ?? null,
        }),
      );
    case "default":
      return unwrapEden(await profile.default.post());
    case "archive":
      return unwrapEden(await profile.archive.post());
    default:
      command satisfies never;
      return panic("Unexpected seller profile command");
  }
};
