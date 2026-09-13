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

## Try a comparison safely

If document comparison is enabled for your stella workspace, begin by checking
the document and versions before requesting a redline. Replace the bracketed
text with your own names:

```text
In stella, find the document "[document name]" in the matter "[matter name]".
List its available versions, including the version date and author. Do not
compare or save anything yet.
```

After checking the returned versions, ask your assistant for a preview:

```text
Create a word-level tracked-changes comparison between version [base version]
and version [target version] of this same document. Use strict mode and preview
only. Tell me whether the comparison was verified. Do not save a new version.
```

The comparison workflow requires permission to update documents in that matter.
A preview does not create a document version. If the preview is correct, ask:

```text
Save this comparison as a derived redline version. Return the link to open it
in stella and the DOCX download link. Report any verification or compatibility
limitations.
```

A successful save creates a derived version without replacing the document's
current version. The download link expires; use the stella link to reopen the
saved redline later.

To show the changes in the other direction, ask for a new preview with the
original base and target versions exchanged. Save that preview only after
checking it.

## Current comparison scope

The available comparison workflow uses two stored DOCX versions of one document
in one matter. Choose the base and target versions explicitly, or compare a
target version with its immediate predecessor. It can preview a comparison or
save it as a derived version. It does not compare separate local files or
versions from different documents.

## Next steps

- Browse [what the connected assistant can do](/docs/reference/tools/).
- Prefer a terminal? [Set up the CLI](/docs/get-started/cli/).
