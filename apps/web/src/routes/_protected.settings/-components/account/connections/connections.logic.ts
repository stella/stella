import { stripUnicodeMarks } from "@stll/text-normalize";
import type { StatusTone } from "@stll/ui/list";

import type { TranslationKey } from "@/i18n/types";
import type {
  McpConnectionsResponse,
  McpConnectorsResponse,
} from "@/lib/knowledge/queries";

/** Case- and accent-insensitive folding, so "cesky" finds "Český". */
const fold = (value: string): string =>
  stripUnicodeMarks(value, {
    form: "NFD",
    markClass: "combining",
  }).toLocaleLowerCase();

/**
 * True when every word of the query appears in one of the fields. An empty
 * query matches everything.
 */
export const matchesConnectionQuery = (
  query: string,
  fields: readonly (string | null | undefined)[],
): boolean => {
  const words = fold(query).split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const haystack = fold(fields.filter(Boolean).join(" "));
  return words.every((word) => haystack.includes(word));
};

export type IntegrationConnection = Pick<
  McpConnectionsResponse["connections"][number],
  "enabled" | "responseDisposition" | "status"
>;
export type IntegrationAuthorizationStatus =
  McpConnectorsResponse["connectors"][number]["authorizationStatus"];

export const canApproveIntegrationAuthorization = (
  canManageOrganizationSettings: boolean,
  authorizationStatus: IntegrationAuthorizationStatus | undefined,
): boolean =>
  canManageOrganizationSettings && authorizationStatus === "needs_reapproval";

type IntegrationStatus = {
  tone: StatusTone;
  labelKey: TranslationKey;
};

/**
 * One status per integration row. `null` for servers that need no sign-in:
 * there is nothing for the user to connect, so a status would be noise.
 */
type IntegrationStatusOptions = {
  authType: "none" | "bearer" | "oauth";
  authorizationStatus: IntegrationAuthorizationStatus | undefined;
  connection: IntegrationConnection | undefined;
};

export const integrationStatus = ({
  authType,
  authorizationStatus,
  connection,
}: IntegrationStatusOptions) => {
  if (authorizationStatus === "needs_reapproval") {
    return {
      tone: "warning",
      labelKey: "knowledge.mcp.needsReapproval",
    } as const satisfies IntegrationStatus;
  }
  if (connection?.status === "needs_approval") {
    return {
      tone: "warning",
      labelKey: "knowledge.mcp.needsReapproval",
    } as const satisfies IntegrationStatus;
  }
  if (connection === undefined || connection.status === "revoked") {
    if (authType === "none") {
      return null;
    }
    return {
      tone: "neutral",
      labelKey: "settings.connections.notConnected",
    } as const satisfies IntegrationStatus;
  }
  if (connection.status === "needs_reauth") {
    return {
      tone: "warning",
      labelKey: "knowledge.mcp.needsReauth",
    } as const satisfies IntegrationStatus;
  }
  if (!connection.enabled) {
    return {
      tone: "neutral",
      labelKey: "settings.connections.turnedOff",
    } as const satisfies IntegrationStatus;
  }
  if (connection.responseDisposition === "receipt-only") {
    return {
      tone: "neutral",
      labelKey: "settings.connections.privateCredentialOnly",
    } as const satisfies IntegrationStatus;
  }
  return {
    tone: "success",
    labelKey: "settings.connections.connected",
  } as const satisfies IntegrationStatus;
};
