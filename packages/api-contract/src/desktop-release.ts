import { Result } from "better-result";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

import updateFeed from "./desktop-update-feed.json";

/**
 * The public feed the desktop updater reads (`plugins.updater.endpoints` in
 * apps/desktop/src-tauri/tauri.conf.json, which a desktop test binds to this
 * file). The API reads the newest release from the same feed.
 */
export const DESKTOP_UPDATE_FEED_URL = updateFeed.url;

/**
 * The version a build made from a checkout reports. Release builds stamp the
 * release tag over it; local builds report the committed value from
 * apps/desktop/src-tauri/Cargo.toml, which local-client-support.test.ts binds
 * this to. No release carries it, so it is never refused nor offered an
 * update.
 */
export const DESKTOP_WORKSPACE_VERSION = "0.0.1";

const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;

const releaseVersionParts = (version: string): number[] | undefined => {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  if (!match) {
    return undefined;
  }
  const parts: number[] = [];
  for (const token of match.slice(1)) {
    const part = parseIntegerToken(token, { sign: "unsigned" });
    if (Result.isError(part)) {
      return undefined;
    }
    parts.push(part.value);
  }
  return parts;
};

/**
 * Whether release `version` comes before release `minimum`. Only plain
 * `X.Y.Z` releases compare; anything else (a pre-release, a build string) is
 * never below.
 */
export const releaseVersionIsBelow = (
  version: string,
  minimum: string,
): boolean => {
  const current = releaseVersionParts(version);
  const floor = releaseVersionParts(minimum);
  if (!current || !floor) {
    return false;
  }
  for (const [index, part] of current.entries()) {
    const difference = part - (floor[index] ?? 0);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
};

/**
 * The first desktop release each feature of a chat on the member's computer
 * needs. Only published releases belong here: a desktop below one is offered
 * an update, which installs that release or a later one.
 */
export const DESKTOP_FEATURE_MINIMUM_VERSIONS = {
  /** Website approvals applied to browser steps on the member's computer. */
  browserSiteApprovals: "0.9.91",
} as const satisfies Record<string, string>;
export type DesktopFeature = keyof typeof DESKTOP_FEATURE_MINIMUM_VERSIONS;
