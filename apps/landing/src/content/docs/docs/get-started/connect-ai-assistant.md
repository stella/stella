---
title: Connect your AI assistant
description: Connect an MCP-compatible AI assistant to your stella workspace.
sidebar:
  order: 1
---

stella exposes a remote MCP server. Any assistant that supports Streamable HTTP
with OAuth can connect to the matters and documents you can access.

## Before you begin

You need a stella account and membership in the organization you plan to use.
Your assistant must support adding a remote MCP server. On managed accounts,
an administrator may need to make the connection available first; each person
then signs in with their own stella account.

## Server address

```text
https://api.stll.app/mcp
```

Self-hosted instances serve `/mcp` on their own API host.

## Connect your assistant

1. Open your assistant's integration settings. Depending on the client, these
   may be called connectors, apps, tools, or MCP servers.
2. Add a remote server named **stella** using the address above.
3. Start the connection and complete the stella sign-in in your browser.
4. Review the organization and requested permissions, then approve or reject
   the connection. The client chooses which permissions to request.

The connection grants access within the organization you select and the
permissions you approve. To request fewer permissions, adjust the client's
scope configuration before authorizing it. You can disconnect from stella's
**Settings → Connections**.

For exact menu labels and account requirements, follow your assistant's remote
MCP setup instructions.

## Check the connection

Start a conversation and make sure stella's tools are available. Some clients
require you to enable the connection separately for each conversation. Ask:

```text
Show the matters I can access and do not make any changes.
```

## Discover available tools

Ask your assistant what it can do with the connected stella tools:

```text
What stella tools are available through this connection, and what can I use
them for?
```

Available actions depend on your permissions and the features enabled on your
stella instance. Browse the [tools reference](/docs/reference/tools/) to explore
the supported capabilities.

## Next steps

- Browse [what the connected assistant can do](/docs/reference/tools/).
- Prefer a terminal? [Set up the CLI](/docs/get-started/cli/).
