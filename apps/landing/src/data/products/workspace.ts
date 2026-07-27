import { frameAccents, type Product } from "./types";

// The live preview is assembled from shared tokens and product UI components,
// so it evolves with the application instead of depending on screenshots.
export const workspace: Product = {
  slug: "workspace",
  eyebrow: "Workspace",
  title: "Matters, documents, review, and chat in one workspace.",
  summary:
    "The workspace holds a matter's documents, Word .docx editing, review, research, and chat in one place, so the work stays in context from source material to answer.",
  metaTitle: "Legal matter management workspace | stella",
  metaDescription:
    "Matters, documents, Word .docx editing, review, research, and chat in one legal workspace. The work stays in context from source material to answer.",
  hero: {
    type: "story",
    sceneId: "workspace",
    aspect: "16 / 10",
  },
  // Frame rhythm down the page: bloom, wash, bloom.
  heroFrameVariant: "bloom",
  frameAccent: frameAccents.iris,
  quickAnswer: {
    question: "What is the stella workspace?",
    answer:
      "A web app that holds matters, documents, Word .docx editing, review, research, and chat in one place. Everything added to a matter stays attached to it, so the context is there when you return. A companion desktop app acts as a local bridge when a document needs Microsoft Word.",
  },
  capabilities: [
    {
      title: "Matters",
      body: "Organise documents, contacts, review, and chat around the matter they belong to. Everything added to a matter stays attached to it, searchable across the whole workspace, so the context is there when you come back.",
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
      title: "Version history",
      body: "Saved edits and uploads become document revisions, so the current file and its history stay together.",
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
      heading: "Word documents, edited where you need them",
      bullets: [
        "Open and edit Word .docx documents directly in the workspace",
        "The redline stays a Word file: no conversion, no copies",
        "Use the desktop bridge when a document needs Microsoft Word",
      ],
      media: {
        type: "story",
        sceneId: "editor",
        aspect: "16 / 10",
      },
      frameVariant: "bloom",
    },
  ],
  faqs: [
    {
      question: "Can I edit Word documents in stella?",
      answer:
        "Yes. The web app supports Word .docx editing and review. For local Office editing, the desktop app acts as a bridge so you can open a document from stella and edit it on your machine.",
    },
    {
      question: "What lives inside a matter?",
      answer:
        "Documents, contacts, review tables, chat threads, and document history. Everything added to a matter stays attached to it, so the context is there when you return.",
    },
    {
      question: "Can other tools reach the workspace?",
      answer:
        "Yes. The stella CLI and MCP server expose the same matters, documents, and case law to connected tools, under the same permissions. See CLI & MCP for details.",
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
      title: "CLI & MCP",
      href: "/product/cli-mcp",
      body: "Reach the same matters, documents, and case law from the CLI and MCP-compatible tools.",
    },
    {
      title: "AI fact sheet",
      href: "/ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  evidence: [
    { type: "capability", id: "workspaces.list" },
    { type: "capability", id: "entities.list" },
    { type: "capability", id: "entities.upload" },
    { type: "capability", id: "views.list" },
    { type: "capability", id: "entities.read-versions" },
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
