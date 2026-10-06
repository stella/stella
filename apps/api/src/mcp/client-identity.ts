import * as v from "valibot";

import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_RESOURCE_MIME_TYPE,
} from "@stll/api-contract";

import { getServerAnalytics } from "@/api/lib/analytics/client";
import type { McpSessionInitializedProperties } from "@/api/lib/analytics/server-analytics";
import { SERVER_ANALYTICS_EVENTS } from "@/api/lib/analytics/server-analytics";
import type { McpSession } from "@/api/mcp/auth";
import type { McpMode } from "@/api/mcp/constants";

/**
 * A client names itself in the `initialize` handshake, so its identity is
 * caller input: it is type-checked and capped here before anything stores or
 * reports it. The cap is generous next to the real names (`claude-ai`,
 * `stella-cli`, `Claude Code`) and short enough that a client cannot turn a
 * telemetry property into a payload.
 */
const MAX_CLIENT_IDENTITY_CHARS = 128;

/** Stands in for a field the handshake left out or reported as a non-string. */
const UNSPECIFIED_CLIENT_FIELD = "unspecified";

type McpClientIdentity = {
  clientName: string;
  clientVersion?: string;
};

const identityField = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const capped = value.trim().slice(0, MAX_CLIENT_IDENTITY_CHARS);
  return capped.length > 0 ? capped : undefined;
};

/**
 * The reported `{ name, version }` reduced to what telemetry may carry. The
 * name always resolves (to `unspecified` when the client reported none) so the
 * event count still equals the number of handshakes; the version is omitted
 * rather than invented when the client reported none.
 */
export const sanitizeMcpClientIdentity = (
  clientInfo: unknown,
): McpClientIdentity => {
  if (typeof clientInfo !== "object" || clientInfo === null) {
    return { clientName: UNSPECIFIED_CLIENT_FIELD };
  }
  const { name, version }: Record<string, unknown> = { ...clientInfo };
  const clientVersion = identityField(version);
  return {
    clientName: identityField(name) ?? UNSPECIFIED_CLIENT_FIELD,
    ...(clientVersion === undefined ? {} : { clientVersion }),
  };
};

const mcpUiCapabilitiesSchema = v.object({
  extensions: v.optional(
    v.object({
      [MCP_APP_EXTENSION_ID]: v.optional(
        v.object({
          mimeTypes: v.optional(v.array(v.string())),
        }),
      ),
    }),
  ),
});

/** Handshake payloads may only contribute the MIME types Stella serves. */
export const sanitizeMcpUiCapabilities = (capabilities: unknown) => {
  const parsed = v.safeParse(mcpUiCapabilitiesSchema, capabilities);
  const mimeTypes = parsed.success
    ? parsed.output.extensions?.[MCP_APP_EXTENSION_ID]?.mimeTypes
    : undefined;
  const uiAppsMimeTypes = mimeTypes?.includes(MCP_APP_RESOURCE_MIME_TYPE)
    ? [MCP_APP_RESOURCE_MIME_TYPE]
    : [];
  return { uiAppsSupported: uiAppsMimeTypes.length > 0, uiAppsMimeTypes };
};

export type RecordMcpSessionInitialized = (args: {
  clientInfo: unknown;
  capabilities: unknown;
  mode: McpMode;
  session: McpSession;
}) => void;

/**
 * One event per `initialize`: which client opened the session, under which
 * credential kind and endpoint mode. The endpoint keeps no session state, so
 * this handshake is the only point at which a client identifies itself on the
 * 2025-era protocol; later requests carry no identity to attribute.
 */
export const recordMcpSessionInitialized: RecordMcpSessionInitialized = ({
  clientInfo,
  capabilities,
  mode,
  session,
}) => {
  const { clientName, clientVersion } = sanitizeMcpClientIdentity(clientInfo);
  const { uiAppsSupported, uiAppsMimeTypes } =
    sanitizeMcpUiCapabilities(capabilities);
  const properties: McpSessionInitializedProperties = {
    client_name: clientName,
    ui_apps_supported: uiAppsSupported,
    ui_apps_mime_types: uiAppsMimeTypes,
    ...(clientVersion === undefined ? {} : { client_version: clientVersion }),
    credential_type: session.credential?.type ?? UNSPECIFIED_CLIENT_FIELD,
    mode,
  };

  getServerAnalytics().capture({
    distinctId: session.userId,
    event: SERVER_ANALYTICS_EVENTS.mcpSessionInitialized,
    groups: { organization: session.organizationId },
    properties,
  });
};
