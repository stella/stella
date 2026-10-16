import { toolDefinition } from "@tanstack/ai";

import {
  CONNECT_CONNECTOR_TOOL_NAME,
  connectConnectorInputSchema,
  connectConnectorOutputSchema,
} from "@stll/api-contract/chat-connector";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";

/**
 * Client-resolved: the card runs the ordinary connect flow in the user's
 * browser, and the receipt endpoint confirms the stored connection before the
 * chat continues. The tool never sees a credential.
 */
export const createConnectorTools = () => ({
  [CONNECT_CONNECTOR_TOOL_NAME]: toolDefinition({
    name: CONNECT_CONNECTOR_TOOL_NAME,
    description:
      "Ask the user to connect an installed connector they have not connected yet, through a consent card in the chat. Use only for a connector listed as available to connect; name its exact connector slug and explain in one sentence why it helps with the current request. Never ask for credentials, tokens or passwords in chat; the card runs the connector's own sign-in. After `connected`, the connector's tools are available from the next turn. If declined, continue without it and do not ask again in this conversation unless the user brings it up.",
    inputSchema: toTanStackToolSchema(connectConnectorInputSchema),
    outputSchema: toTanStackToolSchema(connectConnectorOutputSchema),
  }),
});
