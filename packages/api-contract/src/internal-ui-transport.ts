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
} as const;
