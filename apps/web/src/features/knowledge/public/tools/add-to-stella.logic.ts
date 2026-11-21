import { panic } from "better-result";

import type { LoadedCatalogueEntry } from "@stll/catalogue";

import type { ClientAuthStatus } from "@/hooks/use-client-auth-status";
import type { QueryView } from "@/lib/query-view.logic";

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
  | { type: "catalogue-error" }
  | { type: "installed" }
  | { type: "missing-entry" }
  | { type: "unavailable" }
  | { type: "install" };

type CatalogueRead = QueryView<
  { entries: readonly OrganizationCatalogueEntry[] },
  unknown
>;

type ResolveAddToStellaStateOptions = {
  authStatus: ClientAuthStatus["status"];
  canInstall: boolean | "error" | undefined;
  entry: Pick<LoadedCatalogueEntry, "kind" | "slug">;
  catalogue: CatalogueRead;
};

export const resolveAddToStellaState = ({
  authStatus,
  canInstall,
  entry,
  catalogue,
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
  if (canInstall === undefined || catalogue.type === "pending") {
    return { type: "checking" };
  }
  if (!canInstall) {
    return { type: "forbidden" };
  }
  if (
    catalogue.type === "error" ||
    (catalogue.type === "items" && catalogue.refetchError !== undefined)
  ) {
    return { type: "catalogue-error" };
  }
  if (catalogue.type === "empty") {
    return { type: "missing-entry" };
  }

  const organizationEntry = catalogue.items.entries.find(
    (candidate) =>
      candidate.kind === entry.kind && candidate.slug === entry.slug,
  );
  if (organizationEntry === undefined) {
    return { type: "missing-entry" };
  }
  if (organizationEntry.installState === "unavailable") {
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
