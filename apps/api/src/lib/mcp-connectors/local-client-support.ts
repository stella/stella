import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";
import cliPackage from "@stll/cli/package.json" with { type: "json" };
import mcpKitPackage from "@stll/mcp-kit/package.json" with { type: "json" };

import desktopSupportFloor from "./desktop-support-floor.json" with { type: "json" };

export const LOCAL_CLIENT_IDENTITY_HEADER = "x-stella-local-client";

export const LOCAL_CLIENT_KINDS = ["cli", "mcp-kit", "desktop"] as const;
type LocalClientKind = (typeof LOCAL_CLIENT_KINDS)[number];

export const CLIENT_TOO_OLD_CODE = "client_too_old";

type UpdatePath =
  | { readonly type: "command"; readonly command: string }
  | { readonly type: "desktop_action"; readonly action: "check_for_updates" };

type ClientSupport = {
  readonly minimum: string;
  readonly latest: string;
  readonly update: UpdatePath;
};

// Release builds stamp the release tag over this version; local builds report
// the committed value from apps/desktop/src-tauri/Cargo.toml, which
// local-client-support.test.ts binds this to. No release carries it, so it
// names a build made from a checkout.
const DESKTOP_WORKSPACE_VERSION = "0.0.1";

/**
 * Where a desktop continues an edit session it already holds: status, events,
 * checkpoint, finalize and takeover answers. A desktop below the floor is
 * still answered here. Its updater waits for open sessions to end, and a
 * session ends only on one of these answers, so refusing them would keep both
 * the unsaved edits and the old build on the device. Opening a session is
 * refused.
 */
const DESKTOP_OPEN_SESSION_PATH_PREFIX = `${STELLA_API_VERSION_PREFIX}/desktop-edit-sessions/`;

/**
 * The server-owned support policy for every locally installed client kind.
 * `latest` is the client version in this tree. For the npm clients `minimum`
 * never exceeds it, so the API always accepts the clients built from the same
 * checkout. The desktop minimum is the support floor of docs/releases.md
 * ("Desktop Support"), kept in desktop-support-floor.json, which the release
 * cut moves. It lies above the desktop's workspace version, so
 * `clientTooOldError` accepts that one version by name.
 */
export const LOCAL_CLIENT_SUPPORT = {
  cli: {
    minimum: "5.1.1",
    latest: cliPackage.version,
    update: { type: "command", command: "npm i -g @stll/cli@latest" },
  },
  "mcp-kit": {
    minimum: "0.2.2",
    latest: mcpKitPackage.version,
    update: { type: "command", command: "npm i @stll/mcp-kit@latest" },
  },
  desktop: {
    minimum: desktopSupportFloor.minimumVersion,
    latest: DESKTOP_WORKSPACE_VERSION,
    update: { type: "desktop_action", action: "check_for_updates" },
  },
} as const satisfies Record<LocalClientKind, ClientSupport>;

type ClientTooOldError = {
  readonly code: typeof CLIENT_TOO_OLD_CODE;
  readonly message: string;
  readonly client_kind: LocalClientKind;
  readonly current_version: string;
  readonly minimum_version: string;
  readonly latest_version: string;
  readonly update: UpdatePath;
};

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;

const versionParts = (version: string): readonly number[] | undefined => {
  const match = VERSION_PATTERN.exec(version);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
};

const isBelow = (version: string, minimum: string): boolean => {
  const current = versionParts(version);
  const floor = versionParts(minimum);
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

const isClientKind = (value: string): value is LocalClientKind =>
  LOCAL_CLIENT_KINDS.some((kind) => kind === value);

/** The two desktop requests the floor never refuses. */
const isDesktopFloorExempt = (request: Request, version: string): boolean =>
  version === DESKTOP_WORKSPACE_VERSION ||
  new URL(request.url).pathname.startsWith(DESKTOP_OPEN_SESSION_PATH_PREFIX);

export const clientTooOldError = (
  request: Request,
): ClientTooOldError | undefined => {
  const identity = request.headers.get(LOCAL_CLIENT_IDENTITY_HEADER);
  if (!identity) {
    return undefined;
  }
  const separator = identity.lastIndexOf("/");
  const kind = identity.slice(0, separator);
  const currentVersion = identity.slice(separator + 1);
  if (!isClientKind(kind)) {
    return undefined;
  }
  const support = LOCAL_CLIENT_SUPPORT[kind];
  if (!isBelow(currentVersion, support.minimum)) {
    return undefined;
  }
  if (kind === "desktop" && isDesktopFloorExempt(request, currentVersion)) {
    return undefined;
  }
  return {
    code: CLIENT_TOO_OLD_CODE,
    message: `${kind} ${currentVersion} is too old; update to ${support.minimum} or later`,
    client_kind: kind,
    current_version: currentVersion,
    minimum_version: support.minimum,
    latest_version: support.latest,
    update: support.update,
  };
};
