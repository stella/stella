/** Browser dispatches to mounted internal routes; authorization stays at the API. */
export const INTERNAL_UI_TRANSPORT_ROUTES = {
  invoiceLinkView: {
    id: "invoice-link-view",
    method: "POST",
    path: "/public/invoice-links/view",
    reason: "session_token_exchange",
  },
  invoiceLinkDownload: {
    id: "invoice-link-download",
    method: "POST",
    path: "/public/invoice-links/download",
    reason: "session_token_exchange",
  },
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
