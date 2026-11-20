import { parseIntegerToken } from "@stll/agent-input/numeric-token";

import type {
  BusinessRegistrySearchCapabilities,
  BusinessRegistrySlug,
} from "./business-registries";
import desktopAccountPolicy from "./desktop-account-policy.json";

export const DESKTOP_ACCOUNT_POLICY = desktopAccountPolicy;

/**
 * The account link protocols the page and the API accept. This desktop build
 * speaks `current`; `minimum` keeps installed desktops that are older linking
 * while the release that speaks `current` is not yet published. Once a desktop
 * release with protocol 7 is published, `minimum` rises to 7 and the
 * protocol 6 handling below goes with it.
 */
export const DESKTOP_ACCOUNT_LINK_PROTOCOL = {
  current: desktopAccountPolicy.linkProtocol,
  minimum: 6,
} as const;

/**
 * The first link protocol that signs why a link failed (`failed:<reason>`).
 * An older desktop signs a bare `failed`, which names no reason, so the page
 * reports it as unavailable and offers no account switch.
 */
export const DESKTOP_LINK_FAILURE_REASON_PROTOCOL = 7;

/** A link protocol the page and the API still accept, or `null`. */
export const readDesktopLinkProtocol = (value: string | null) => {
  const parsed = parseIntegerToken(value, {
    sign: "unsigned",
    min: DESKTOP_ACCOUNT_LINK_PROTOCOL.minimum,
    max: DESKTOP_ACCOUNT_LINK_PROTOCOL.current,
  });
  // The app spells its protocol canonically; `07` is not protocol 7.
  return parsed.isOk() && String(parsed.value) === value ? parsed.value : null;
};
export const DESKTOP_ACCOUNT_PROTOCOL_HEADER =
  "X-Stella-Desktop-Account-Protocol";

export type DesktopRegistryConfig = {
  registries: {
    id: BusinessRegistrySlug;
    name: string;
    /** Absent only when a newer desktop is connected to an older API. */
    formatType?: "company-specification" | "registry-reference";
    /** Absent only when a newer desktop is connected to an older API. */
    searchCapabilities?: BusinessRegistrySearchCapabilities;
  }[];
  defaultRegistryId: BusinessRegistrySlug | null;
};

export type DesktopRegistrySearchResult = {
  id: string;
  name: string;
  /** Markers stripped, for desktops older than `rendered`; remove once those are unsupported. */
  text: string;
  /** Rendered output with its `**bold**` / `*italic*` markers intact.
   *  Absent only when a newer desktop is connected to an older API. */
  rendered?: string;
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
