import { panic } from "better-result";

import type { SharepointConnection } from "./sharepoint-queries";

/**
 * Whether SharePoint exists for the signed-in member, read from the answer of
 * `GET /v1/sharepoint/connection`. Both gates fail closed: the deployment flag
 * answers 404 so the feature is not advertised, and an organization that has
 * not opted in answers 403.
 */
export const SHAREPOINT_ACCESS = {
  /** The deployment does not offer SharePoint; nothing of it is shown. */
  unavailable: "unavailable",
  /** The organization has not turned SharePoint on. */
  disabled: "disabled",
  /** The organization allows it; the member may or may not have connected. */
  enabled: "enabled",
} as const;

export type SharepointAccess =
  | { type: typeof SHAREPOINT_ACCESS.unavailable }
  | { type: typeof SHAREPOINT_ACCESS.disabled }
  | {
      type: typeof SHAREPOINT_ACCESS.enabled;
      connection: SharepointConnection | null;
    };

const FEATURE_ABSENT_STATUS = 404;
const ORGANIZATION_DISABLED_STATUS = 403;

/**
 * The gate a refused connection read stands for, or `null` when the refusal
 * is a real failure (an outage, a transport error) the caller must surface.
 */
export const sharepointAccessFromRefusal = ({
  status,
  transport,
}: {
  status: number;
  /** Set when the request never got an HTTP answer. */
  transport: boolean;
}):
  | { type: typeof SHAREPOINT_ACCESS.unavailable }
  | { type: typeof SHAREPOINT_ACCESS.disabled }
  | null => {
  if (transport) {
    return null;
  }
  switch (status) {
    case FEATURE_ABSENT_STATUS:
      return { type: SHAREPOINT_ACCESS.unavailable };
    case ORGANIZATION_DISABLED_STATUS:
      return { type: SHAREPOINT_ACCESS.disabled };
    default:
      return null;
  }
};

/** What the member's own connection lets them do. */
export const SHAREPOINT_CONNECTION_STATE = {
  notConnected: "not-connected",
  connected: "connected",
  reconnectRequired: "reconnect-required",
} as const;

type SharepointConnectionState =
  (typeof SHAREPOINT_CONNECTION_STATE)[keyof typeof SHAREPOINT_CONNECTION_STATE];

export const sharepointConnectionState = (
  connection: Pick<SharepointConnection, "status"> | null,
): SharepointConnectionState => {
  if (connection === null) {
    return SHAREPOINT_CONNECTION_STATE.notConnected;
  }
  switch (connection.status) {
    case "connected":
      return SHAREPOINT_CONNECTION_STATE.connected;
    case "reconnect_required":
      return SHAREPOINT_CONNECTION_STATE.reconnectRequired;
    default:
      connection.status satisfies never;
      return panic(
        `Unknown SharePoint connection status: ${String(connection.status)}`,
      );
  }
};
