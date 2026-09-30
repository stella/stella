import { panic } from "better-result";

import type { LoadedCatalogueEntry } from "@stll/catalogue";

import type { ClientAuthStatus } from "@/hooks/use-client-auth-status";

type OrganizationCatalogueEntry = {
  kind: LoadedCatalogueEntry["kind"];
  slug: string;
  installState: "installed" | "available" | "unavailable";
  enabled: boolean | null;
};

export type AddToStellaState =
  | { type: "checking" }
  | { type: "sign-in" }
  | { type: "forbidden" }
  | { type: "role-error" }
  | { type: "installed" }
  | { type: "unavailable" }
  | { type: "install" };

type ResolveAddToStellaStateOptions = {
  authStatus: ClientAuthStatus["status"];
  canInstall: boolean | "error" | undefined;
  entry: Pick<LoadedCatalogueEntry, "kind" | "slug">;
  organizationEntries: readonly OrganizationCatalogueEntry[] | undefined;
};

export const resolveAddToStellaState = ({
  authStatus,
  canInstall,
  entry,
  organizationEntries,
}: ResolveAddToStellaStateOptions): AddToStellaState => {
  switch (authStatus) {
    case "checking":
      return { type: "checking" };
    // Signing in is also how an unreadable session recovers.
    case "anonymous":
    case "unavailable":
      return { type: "sign-in" };
    case "authenticated":
      break;
    default:
      authStatus satisfies never;
      return panic(`Unhandled session status: ${String(authStatus)}`);
  }
  if (canInstall === "error") {
    return { type: "role-error" };
  }
  if (canInstall === undefined || organizationEntries === undefined) {
    return { type: "checking" };
  }
  if (!canInstall) {
    return { type: "forbidden" };
  }

  const organizationEntry = organizationEntries.find(
    (candidate) =>
      candidate.kind === entry.kind && candidate.slug === entry.slug,
  );
  if (!organizationEntry || organizationEntry.installState === "unavailable") {
    return { type: "unavailable" };
  }
  if (
    organizationEntry.installState === "installed" &&
    !(organizationEntry.kind === "native-tool" && !organizationEntry.enabled)
  ) {
    return { type: "installed" };
  }
  return { type: "install" };
};
