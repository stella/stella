// Content directives are shared with the fixture host's browser smoke.
export const MCP_APP_SANDBOX_CONTENT_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
] as const;
