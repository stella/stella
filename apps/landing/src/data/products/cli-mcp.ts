import { frameAccents, type Product } from "./types";

export const cliMcp: Product = {
  slug: "cli-mcp",
  eyebrow: "CLI & MCP",
  title: "One workspace, from every tool.",
  summary:
    "Search, read, and work with stella from the command line or any MCP-compatible client. Both surfaces share the same capability registry, permissions, and workspace data as the web app.",
  metaTitle: "MCP server and CLI for your legal workspace | stella",
  metaDescription:
    "Search, read, and work with stella from the command line or any MCP-compatible client. Both surfaces share the same capabilities, permissions, and data.",
  hero: {
    type: "story",
    sceneId: "cli",
    showCompanions: true,
    // Slim to CLI terminal + main stella window (drop the Teams + Editor side
    // windows) so this page's hero reads as a clean CLI -> stella pair; the
    // homepage opening story keeps the full four-window scene.
    sideWindows: false,
    aspect: "2.03",
  },
  // Frame rhythm down the page: bloom, wash, bloom.
  heroFrameVariant: "bloom",
  frameAccent: frameAccents.sky,
  quickAnswer: {
    question: "What are the stella CLI and MCP server?",
    answer:
      "They are two interfaces to the same stella capabilities. The CLI mirrors the MCP tool registry as commands, while the MCP server lets compatible agents and tools work with matters, documents, templates, and public legal data under the same access controls.",
  },
  capabilities: [
    {
      title: "A real command line",
      body: "Use generated commands such as stella search matters, document read, and template fill from scripts or your terminal.",
    },
    {
      title: "MCP-compatible",
      body: "Connect stella to MCP-compatible clients without building a separate integration for each one.",
    },
    {
      title: "One capability registry",
      body: "The CLI command surface is generated from the MCP tool registry, so the two interfaces stay aligned as stella evolves.",
    },
    {
      title: "Workspace permissions apply",
      body: "Authentication scopes and workspace permissions remain the boundary, whichever interface you use.",
    },
    {
      title: "Structured output",
      body: "Commands return machine-readable JSON for scripts and agents as well as readable terminal output for people.",
    },
    {
      title: "Self-host friendly",
      body: "Point the CLI and MCP clients at the stella server your organisation operates.",
    },
  ],
  sections: [
    {
      heading: "Search the whole matter from your terminal",
      bullets: [
        "Find passages across matter documents with stella search matters",
        "Read documents, list matters, and inspect templates without switching context",
        "Use paginated, structured results in scripts and automated workflows",
      ],
      media: {
        type: "preview",
        key: "cli-mcp",
      },
      frameVariant: "wash",
    },
    {
      heading: "The same capabilities through MCP",
      bullets: [
        "Expose matters, documents, case law, templates, and other approved tools",
        "Keep the capability catalogue and CLI commands generated from one registry",
        "Connect compatible agents without copying legal data into another workspace",
      ],
      media: {
        type: "preview",
        key: "cli-mcp-template",
      },
      frameVariant: "bloom",
    },
  ],
  faqs: [
    {
      question: "Is the CLI a separate product from the MCP server?",
      answer:
        "No. They are separate interfaces generated from the same capability registry and connected to the same stella server.",
    },
    {
      question: "Can I use the CLI in scripts?",
      answer:
        "Yes. The CLI supports structured JSON output, pagination, predictable exit codes, and non-interactive use suitable for automation.",
    },
    {
      question: "Does connecting an MCP client bypass workspace permissions?",
      answer:
        "No. The server checks authentication scopes and stella permissions before a capability runs.",
    },
  ],
  adjacent: [
    {
      title: "Workspace",
      href: "/product/workspace",
      body: "Matters, documents, review, and chat in one workspace.",
    },
    {
      title: "AI agent",
      href: "/product/agent",
      body: "Work across matters and connected tools with approvals and citations.",
    },
    {
      title: "Templates",
      href: "/product/templates",
      body: "Fill reusable legal documents through the app, CLI, or connected tools.",
    },
    {
      title: "AI fact sheet",
      href: "/ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  evidence: [
    {
      type: "source",
      path: "packages/cli/src/generate-capability-tree.ts",
      contains: ["export const buildCliRouteTree"],
    },
    {
      type: "source",
      path: "apps/api/src/mcp/server-core.ts",
      contains: ["export const createMcpHttpRequestHandler"],
    },
    { type: "capability", id: "workspaces.read" },
  ],
  cta: {
    heading: "Bring stella into the tools where you already work.",
    href: "https://github.com/stella/stella/tree/main/packages/cli",
    label: "Get the CLI",
  },
};
