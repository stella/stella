---
title: Connect your AI assistant
description: Connect Claude or another MCP client to your stella workspace.
sidebar:
  order: 1
---

Connect Claude to stella's remote MCP server to work with the matters and
documents you can access. This is a remote connection: there is no local
installer or plugin to download.

## Before you begin

You need a stella account and membership in the organization you plan to use.
Your Claude account must allow custom connectors. The connection is authorized
for each person, so it only reaches the stella organization and documents that
person can access.

## Connect a personal Claude account

In Claude on the web or desktop app:

1. Open **Customize → Connectors**.
2. Select the **+** button, then choose **Add custom connector**.
3. Enter **stella** as the name and this remote MCP address:

   ```text
   https://api.stll.app/mcp
   ```

4. Select **Add**. Leave advanced OAuth settings empty unless your stella
   administrator gave you different values.
5. Select **Connect**, then complete the stella sign-in in the browser.

## Connect a Claude organization

On managed plans, an Owner or Primary Owner first makes the connector available
to the organization:

1. Open **Organization settings → Connectors**.
2. Select **Add → Custom → Web**.
3. Add `https://api.stll.app/mcp`, then select **Add**.

Each member then opens **Customize → Connectors**, finds the custom stella
connector, and selects **Connect** to complete their own stella sign-in.

## Sign in to stella

The stella page asks for your email and one-time code, then shows the
organization and requested permissions. Check both before approving the
connection. A connection grants access only within the organization you select.

You can remove the connector or reconnect it later from **Customize →
Connectors**. See [Claude's current custom connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
if the labels in Claude have changed.

## Start a chat

Connectors are enabled per conversation. In a new chat, select the **+** button
beside the message field, choose **Connectors**, and turn on **stella**. Ask a
small read-only question first to confirm the organization in use:

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

After checking the returned versions, ask Claude for a preview:

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

## Other MCP clients

Any client that supports a remote HTTP MCP server with OAuth can connect to
`https://api.stll.app/mcp`. Add that address in the client's remote connector
settings, then complete the same stella sign-in and permission review.

## Next steps

- Browse [what the connected assistant can do](/docs/reference/tools/).
- Prefer a terminal? [Set up the CLI](/docs/get-started/cli/).
