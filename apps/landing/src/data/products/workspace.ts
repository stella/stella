import { frameAccents, type Product } from "./types";

// The live preview is assembled from shared tokens and product UI components,
// so it evolves with the application instead of depending on screenshots.
export const workspace: Product = {
  slug: "workspace",
  eyebrow: "Workspace",
  title: "Matters, documents, and tools in one workspace.",
  summary:
    "A web app that brings matters, documents, Word .docx editing, review, research, chat, and knowledge tools together. A desktop app bridges local Office editing, and a stella MCP server exposes your matters, documents, and case law.",
  metaTitle: "Legal matter management workspace | stella",
  metaDescription:
    "A web app bringing matters, documents, Word .docx editing, review, research, and chat together, with a desktop bridge for local Office and an MCP server.",
  hero: {
    type: "story",
    sceneId: "workspace",
    aspect: "16 / 10",
  },
  // Frame rhythm down the page: bloom, wash, bloom, ripple.
  heroFrameVariant: "bloom",
  frameAccent: frameAccents.iris,
  quickAnswer: {
    question: "What is the stella workspace?",
    answer:
      "A web app that holds matters, documents, Word .docx editing, review, research, chat, and knowledge tools in one place. A companion desktop app acts as a local bridge for editing Office documents, and a stella MCP server exposes matters, documents, and case law.",
  },
  capabilities: [
    {
      title: "Matters",
      body: "Organise documents, contacts, review, and chat around the matter they belong to.",
    },
    {
      title: "Documents and .docx editing",
      body: "Open, edit, and review Word .docx documents directly in the workspace.",
    },
    {
      title: "Review and research",
      body: "Run tabular review and research alongside the documents they relate to.",
    },
    {
      title: "Chat and knowledge tools",
      body: "Bring the AI agent and knowledge tools into the same workspace as your files.",
    },
    {
      title: "Desktop bridge",
      body: "A desktop app acts as a local bridge for editing Office documents from stella.",
    },
    {
      title: "MCP server",
      body: "A stella MCP server exposes matters, documents, and case law to connected tools.",
    },
  ],
  sections: [
    {
      heading: "Everything for a matter, in one place",
      bullets: [
        "Documents, contacts, review, and chat live inside the matter",
        "Edit Word .docx documents without leaving the workspace",
        "Move between research, review, and chat without switching apps",
      ],
      media: {
        type: "story",
        sceneId: "review",
        aspect: "16 / 10",
      },
      frameVariant: "wash",
    },
    {
      heading: "A bridge to local Office editing",
      bullets: [
        "The desktop app is a local bridge for editing Office documents",
        "Open a document from stella and edit it on your machine",
        "Keep your existing Office editing where the workspace cannot reach",
      ],
      media: {
        type: "story",
        sceneId: "editor",
        aspect: "16 / 10",
      },
      frameVariant: "bloom",
    },
    {
      heading: "Connect stella to your tools",
      bullets: [
        "A stella MCP server exposes matters, documents, and case law",
        "Reach the workspace from MCP-compatible tools and the agent",
        "Use the same workspace from the web app, desktop bridge, and connected tools",
      ],
      media: {
        type: "story",
        sceneId: "cli",
        showCompanions: true,
        aspect: "2.03",
      },
      frameVariant: "ripple",
    },
  ],
  faqs: [
    {
      question: "Can I edit Word documents in stella?",
      answer:
        "Yes. The web app supports Word .docx editing and review. For local Office editing, the desktop app acts as a bridge so you can open a document from stella and edit it on your machine.",
    },
    {
      question: "What does the MCP server expose?",
      answer:
        "A stella MCP server gives connected tools and the agent access to your matters, documents, and case law.",
    },
  ],
  adjacent: [
    {
      title: "AI agent",
      href: "/product/agent",
      body: "Chat across matters, files, and connected tools with approvals and source previews.",
    },
    {
      title: "Tabular Review",
      href: "/product/tabular-review",
      body: "Turn a document set into a matter-scoped table you can sort, filter, and trace.",
    },
    {
      title: "Anonymization",
      href: "/product/anonymization",
      body: "Prepare material for AI without exposing names, entities, or identifying details.",
    },
    {
      title: "AI fact sheet",
      href: "/ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  evidence: [
    { type: "capability", id: "workspaces.read" },
    { type: "capability", id: "entities.read" },
    { type: "capability", id: "entities.upload" },
    { type: "capability", id: "views.read" },
    {
      type: "source",
      path: "apps/desktop/src/mainview/App.tsx",
      contains: ["export default function App()"],
    },
    {
      type: "source",
      path: "apps/web/src/routes/_protected.workspaces/$workspaceId/$viewId.document.tsx",
      contains: ["DocxBrowserEditor", "ReadOnlyDocxDocumentViewer"],
    },
    {
      type: "source",
      path: "apps/api/src/mcp/server-core.ts",
      contains: ["export const createMcpHttpRequestHandler"],
    },
  ],
  cta: {
    heading: "Bring your matters into one workspace.",
    href: "https://my.stll.app",
    label: "Start free",
  },
};
