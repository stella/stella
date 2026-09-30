---
title: Connect your AI assistant
description: Connect an MCP-compatible AI assistant to your stella workspace.
sidebar:
  order: 1
---

stella exposes a remote MCP server. Any assistant that supports Streamable HTTP
with OAuth can connect to the matters and documents you can access.

The fastest way is to let your agent do it: copy the instructions from
**Settings → Connections** in stella and paste them into Claude Code, Codex,
Cursor, or another agent. The steps it follows are below.

## Instructions for AI agents

If your user asked you to connect them to stella, follow these steps. Use the
server address they gave you; without one, use `https://api.stll.app/mcp`.

1. Add stella as a remote MCP server named `stella` (Streamable HTTP with
   OAuth):
   - Claude Code: `claude mcp add --transport http stella <server address>`
   - Codex: `codex mcp add stella --url <server address>`, then
     `codex mcp login stella`
   - Any other client: add a remote HTTP MCP server with that address in the
     client's MCP settings.
2. Start the connection. A stella sign-in opens in the browser, where your user
   signs in, checks the organization and permissions, and approves. Wait for
   them to finish.
3. If you can run shell commands, install the CLI with `npm i -g @stll/cli` and
   sign in with `stella auth login --server <API address>`, where the API
   address is the server address without `/mcp`.
4. Check the connection with a read-only call, such as listing the matters your
   user can access. Do not change anything.
5. Tell your user what they can now do through stella.

If your user wants personal data masked, use the address ending in
`/mcp-anonymized` instead; for public case law and legislation only, use
`/mcp-law`. If you cannot change your own settings or run commands, as in a
chat app, point your user to the manual steps below.

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

## Connect Claude

Custom connectors work in Claude on the web, Claude Desktop, and Cowork, on
every plan (Free accounts are limited to one custom connector).

1. **Add the connector.** On an individual plan, open **Customize →
   Connectors**, select **+**, then **Add custom connector**. Enter the name
   **stella** and the server address, then select **Add**. On Team and
   Enterprise plans, an owner adds it once under **Organization settings →
   Connectors** (**Add → Custom → Web**); members then find it under
   **Customize → Connectors**.
2. **Connect.** Select **Connect** next to stella. A stella sign-in opens in
   your browser.
3. **Authorize access in stella.** Sign in, check the organization and the
   listed permissions, then select **Allow**. Until you allow it, Claude sees
   no stella tools.
4. **Enable it in the conversation.** In a chat, select **+**, open
   **Connectors**, and switch stella on. The switch applies per conversation.
5. **Approve tool calls.** The first time Claude uses a stella tool, it asks
   for approval. Approve each call, or choose **Allow always** for tools you
   trust.

If stella tools you expect are missing, disconnect and connect again under
**Customize → Connectors**; Claude reads the tool list and permissions when
the connection is made. Claude's
[custom connector guide](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
has current menu labels.

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
