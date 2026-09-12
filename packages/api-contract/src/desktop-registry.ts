import type { BusinessRegistrySlug } from "./business-registries";

export type DesktopRegistryConfig = {
  registries: {
    id: BusinessRegistrySlug;
    name: string;
    /** Absent only when a newer desktop is connected to an older API. */
    formatType?: "company-specification" | "registry-reference";
  }[];
  defaultRegistryId: BusinessRegistrySlug | null;
};

export type DesktopRegistrySearchResult = {
  id: string;
  name: string;
  text: string;
};

export type DesktopRegistrySearchResponse = {
  results: DesktopRegistrySearchResult[];
  formats: { id: string; name: string }[];
  defaultFormatId: string | null;
};
