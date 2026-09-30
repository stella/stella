import type { StatusTone } from "@stll/ui/list";

import type { TranslationKey } from "@/i18n/types";

/** Case- and accent-insensitive folding, so "cesky" finds "Český". */
const fold = (value: string): string =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();

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

export type IntegrationConnection = {
  status: "connected" | "needs_reauth" | "revoked";
  enabled: boolean;
};

export type IntegrationStatus = {
  tone: StatusTone;
  labelKey: TranslationKey;
};

/**
 * One status per integration row. `null` for servers that need no sign-in:
 * there is nothing for the user to connect, so a status would be noise.
 */
export const integrationStatus = (
  authType: "none" | "bearer" | "oauth",
  connection: IntegrationConnection | undefined,
): IntegrationStatus | null => {
  if (connection === undefined || connection.status === "revoked") {
    if (authType === "none") {
      return null;
    }
    return { tone: "neutral", labelKey: "settings.connections.notConnected" };
  }
  if (connection.status === "needs_reauth") {
    return { tone: "warning", labelKey: "knowledge.mcp.needsReauth" };
  }
  if (!connection.enabled) {
    return { tone: "neutral", labelKey: "settings.connections.turnedOff" };
  }
  return { tone: "success", labelKey: "settings.connections.connected" };
};
