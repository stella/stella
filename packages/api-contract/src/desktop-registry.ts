import type { BusinessRegistrySlug } from "./business-registries";
import desktopAccountPolicy from "./desktop-account-policy.json";

export const DESKTOP_ACCOUNT_POLICY = desktopAccountPolicy;

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
  /** Markers stripped, for desktops older than `rendered`; remove once those are unsupported. */
  text: string;
  /** Rendered output with its `**bold**` / `*italic*` markers intact. */
  rendered: string;
};

/** Whose default `defaultFormatId` is; `null` when there is none to own. */
export const DESKTOP_REGISTRY_DEFAULT_FORMAT_SOURCE = {
  user: "user",
  organization: "organization",
} as const;

export type DesktopRegistryDefaultFormatSource =
  (typeof DESKTOP_REGISTRY_DEFAULT_FORMAT_SOURCE)[keyof typeof DESKTOP_REGISTRY_DEFAULT_FORMAT_SOURCE];

export type DesktopRegistryDefaultFormat = {
  defaultFormatId: string | null;
  defaultFormatSource: DesktopRegistryDefaultFormatSource | null;
};

export type DesktopRegistrySearchResponse = DesktopRegistryDefaultFormat & {
  results: DesktopRegistrySearchResult[];
  formats: { id: string; name: string }[];
};
