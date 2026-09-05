import { frameAccents, productCtaLabels, type Product } from "./types";

export const cliMcp = {
  slug: "cli-mcp",
  hero: {
    type: "story",
    sceneId: "cli",
    showCompanions: true,
    // Slim to CLI terminal + main stella window (drop the Teams + Editor side
    // windows) so this page's hero reads as a clean CLI -> stella pair; the
    // homepage opening story keeps the full four-window scene.
    sideWindows: false,
    aspect: "2.03",
    // Mobile stacks the app and terminal, so the desktop-wide ratio would
    // leave less height than the terminal chrome alone requires.
    mobileAspect: "1 / 1",
  },
  heroFrameVariant: "bloom",
  frameAccent: frameAccents.sky,
  setup: {
    endpoint: "https://api.stll.app/mcp",
    clients: {
      chatgpt: { name: "ChatGPT" },
      claude: { name: "Claude" },
      codex: {
        name: "Codex",
        snippet:
          "codex mcp add stella --url https://api.stll.app/mcp\ncodex mcp login stella",
      },
      "claude-code": {
        name: "Claude Code",
        snippet:
          "claude mcp add --transport http stella https://api.stll.app/mcp",
      },
    },
    outroSnippet: "npm i -g @stll/cli\nstella auth login",
  },
  adjacent: {
    "product:workspace": { to: "product", slug: "workspace" },
    "product:agent": { to: "product", slug: "agent" },
    "product:templates": { to: "product", slug: "templates" },
    "ai-info": { to: "ai-info" },
  },
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
    { type: "capability", id: "matters.list" },
  ],
  cta: {
    href: "https://github.com/stella/stella/tree/main/packages/cli",
    label: productCtaLabels.getCli,
  },
} satisfies Product<"cli-mcp">;
