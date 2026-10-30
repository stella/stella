/** Browser dispatches to mounted internal routes; authorization stays at the API. */
export const INTERNAL_UI_TRANSPORT_ROUTES = {
  mcpConnectorConnect: {
    id: "mcp-connector-connect",
    method: "POST",
    path: "/v1/mcp/connectors/:slug/connect",
    reason: "mcp_transport",
  },
  chatConnectorReceipt: {
    id: "chat-connector-receipt",
    method: "POST",
    path: "/v1/chat/threads/:threadId/connectors/:toolCallId",
    reason: "chat_thread_ui",
  },
  sharepointConnect: {
    id: "sharepoint-connect",
    method: "POST",
    path: "/v1/sharepoint/connect",
    reason: "provider_secret",
  },
  sharepointCapabilities: {
    id: "sharepoint-capabilities",
    method: "PUT",
    path: "/v1/sharepoint/capabilities",
    reason: "provider_secret",
  },
  sharepointDisable: {
    id: "sharepoint-disable",
    method: "PUT",
    path: "/v1/sharepoint/enablement",
    reason: "provider_secret",
  },
  sharepointDisconnect: {
    id: "sharepoint-disconnect",
    method: "DELETE",
    path: "/v1/sharepoint/connection",
    reason: "provider_secret",
  },
} as const;
