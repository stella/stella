<p align="center">
  <img src=".github/assets/banner.png" alt="stll/mcp" width="100%" />
</p>

# stella MCP server

stella MCP turns a stella workspace into something AI tools can work with
directly. Instead of copying files, pasting matter context, or wiring custom
API calls by hand, MCP-compatible clients can search, read and act through a
single permission-aware gateway.

Use it to give agents structured access to stella matters, documents, contacts,
case law, skills and connected tools. The same gateway can expose anonymized
read/search surfaces for clients that should not receive raw legal or personal
data.

The server exposes two MCP resources:

- `/mcp`: the default stella MCP. It includes first-party stella tools,
  OpenAI-compatible `search` / `fetch` tools, user-managed skills, and enabled
  external MCP connectors.
- `/mcp-anonymized`: the anonymized MCP mode. It exposes anonymized search and
  read tools for clients that should receive anonymized results.

OAuth protected-resource discovery is served from:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-protected-resource/mcp-anonymized`

## Code map

- `constants.ts`: resource paths, scopes and discovery URLs.
- `stella-tools.ts`: first-party stella tool definitions and handlers.
- `compat-tools.ts`: OpenAI-compatible `search` / `fetch` tools, including
  anonymized variants.
- `gateway/`: dynamic gateway for user-managed skills and external MCP tools.
- `server.ts` and `server-core.ts`: MCP HTTP transport wiring.
- `../handlers/mcp/routes-core.ts`: Elysia routes that expose the MCP resources.
- `../handlers/mcp-connectors/`: connector management APIs used by the web app.
