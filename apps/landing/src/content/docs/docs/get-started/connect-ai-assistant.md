---
title: Connect your AI assistant
description: Give Claude, ChatGPT, or any MCP client access to your stella workspace.
sidebar:
  order: 1
---

stella exposes a remote [MCP](https://modelcontextprotocol.io) server. Any
assistant that supports remote MCP servers with OAuth can connect to your
workspace; you approve exactly which permissions it gets.

## Server address

```
https://api.stll.app/mcp
```

Self-hosted instances serve the same endpoint on their own API host.

## Claude

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. Paste the server address above and confirm.
3. Claude opens stella's sign-in page: enter your email and the one-time code
   you receive.
4. Review the requested permissions and choose which to grant. Grants are per
   organization; you can disconnect at any time from stella's
   **Settings → Connections**.

## ChatGPT

1. In ChatGPT, open **Settings → Connectors** (or enable developer mode if
   your plan requires it for custom connectors).
2. Add a connector with the server address above.
3. Complete the same sign-in and permission review in the stella window that
   opens.

## Other MCP clients

Any client speaking Streamable HTTP with OAuth 2.0 works the same way: point
it at the server address and complete the browser sign-in. The server
advertises its scopes; grant only what the client should be able to do.

## Next steps

- Browse [what the connected assistant can do](/docs/reference/tools/).
- Prefer a terminal? [Set up the CLI](/docs/get-started/cli/).
