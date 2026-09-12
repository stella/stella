import type { BusinessRegistrySlug } from "./business-registries";

export type DesktopRegistryConfig = {
  registries: {
    id: BusinessRegistrySlug;
    name: string;
    formatType: "company-specification" | "registry-reference";
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
