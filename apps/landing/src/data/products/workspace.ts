import type { Product } from "./types";

// Screenshots are stubbed as placeholders; each note describes the exact
// seeded state the Playwright capture should produce, so swapping in real
// images later is a one-line change per section.
export const workspace: Product = {
  slug: "workspace",
  eyebrow: "Workspace",
  title: "Matters, documents, and tools in one workspace.",
  summary:
    "A web app that brings matters, documents, Word .docx editing, review, research, chat, and knowledge tools together. A desktop app bridges local Office editing, and a stella MCP server exposes your matters, documents, and case law.",
  hero: {
    type: "placeholder",
    note: "Web app: a matter open with its documents, a review tab, and chat side by side",
    aspect: "16 / 10",
  },
  quickAnswer: {
    question: "What is the stella workspace?",
    answer:
      "A web app that holds matters, documents, Word .docx editing, review, research, chat, and knowledge tools in one place. A companion desktop app acts as a local bridge for editing Office documents, and a stella MCP server exposes matters, documents, and case law. An Outlook add-in is coming soon.",
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
        type: "placeholder",
        note: "Matter view with tabs for documents, review, and chat across the top",
      },
    },
    {
      heading: "A bridge to local Office editing",
      bullets: [
        "The desktop app is a local bridge for editing Office documents",
        "Open a document from stella and edit it on your machine",
        "Keep your existing Office editing where the workspace cannot reach",
      ],
      media: {
        type: "placeholder",
        note: "Desktop bridge: a document opened from stella in a local Office editor",
      },
    },
    {
      heading: "Connect stella to your tools",
      bullets: [
        "A stella MCP server exposes matters, documents, and case law",
        "Reach the workspace from MCP-compatible tools and the agent",
        "An Outlook add-in is coming soon",
      ],
      media: {
        type: "placeholder",
        note: "MCP server overview listing matters, documents, and case law as available data",
      },
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
    {
      question: "Is there an Outlook add-in?",
      answer: "An Outlook add-in is coming soon.",
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
  cta: {
    heading: "Bring your matters into one workspace.",
    href: "https://my.stll.app",
    label: "Start free",
  },
};
