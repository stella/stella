import type { BusinessRegistrySlug } from "./business-registries";

export type DesktopRegistryConfig = {
  registries: { id: BusinessRegistrySlug; name: string }[];
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

