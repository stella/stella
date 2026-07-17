import type { LoadedCatalogueEntry } from "@stll/catalogue";

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
  | { type: "installed" }
  | { type: "unavailable" }
  | { type: "install" };

type ResolveAddToStellaStateOptions = {
  authStatus: "checking" | "anonymous" | "authenticated";
  canInstall: boolean | undefined;
  entry: Pick<LoadedCatalogueEntry, "kind" | "slug">;
  organizationEntries: readonly OrganizationCatalogueEntry[] | undefined;
};

export const resolveAddToStellaState = ({
  authStatus,
  canInstall,
  entry,
  organizationEntries,
}: ResolveAddToStellaStateOptions): AddToStellaState => {
  if (authStatus === "checking") {
    return { type: "checking" };
  }
  if (authStatus === "anonymous") {
    return { type: "sign-in" };
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
