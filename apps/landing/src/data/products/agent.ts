import type { Product } from "./types";

// The hero reuses the same agent scene as the opening product story.
export const agent: Product = {
  slug: "agent",
  eyebrow: "AI agent",
  title: "An AI agent that works across your matters, files, and tools.",
  summary:
    "Chat with your matters, documents, registries, and connected tools in one place. The agent acts with approvals and source previews, grounds its answers in citations, and extends through skills and external connectors.",
  hero: {
    type: "story",
    sceneId: "agent",
    aspect: "16 / 10",
  },
  quickAnswer: {
    question: "What can the AI agent do?",
    answer:
      "The agent chats with your matters, files, company registries, and connected tools. It asks for approval before acting, shows a source preview for what it reads, and grounds answers in citations. You can extend it with reusable skills and external connectors that are MCP-compatible.",
  },
  capabilities: [
    {
      title: "Works across your matters",
      body: "Ask questions over the matters, documents, and contacts you already have in stella.",
    },
    {
      title: "Reads your files",
      body: "Bring documents into the conversation and ask the agent to read, compare, or summarise them.",
    },
    {
      title: "Connected tools",
      body: "Reach company registries and other connected sources without leaving the chat.",
    },
    {
      title: "Approvals before acting",
      body: "The agent asks before it acts, so you stay in control of each step.",
    },
    {
      title: "Source previews",
      body: "See what the agent is reading with a preview of the source behind each step.",
    },
    {
      title: "Grounded by citations",
      body: "Answers link back to the underlying text instead of free-floating summaries.",
    },
  ],
  sections: [
    {
      heading: "Ask once, across everything in the matter",
      bullets: [
        "Chat over matters, documents, and contacts in one conversation",
        "Pull company and registry data into the same thread",
        "Hand a tabular review to the agent for follow-up questions",
      ],
      media: {
        type: "story",
        sceneId: "agent",
        aspect: "16 / 10",
      },
    },
    {
      heading: "You stay in control",
      bullets: [
        "Each action waits for your approval before it runs",
        "A source preview shows what the agent read for every step",
        "Answers are grounded by citations you can open and verify",
      ],
      media: {
        type: "story",
        sceneId: "agent",
        aspect: "16 / 10",
      },
    },
    {
      heading: "Extend it with skills and connectors",
      bullets: [
        "Skills are reusable prompts and tool definitions you can reuse across matters",
        "External connectors are MCP-compatible, so the agent reaches more tools",
        "Add capabilities without changing how the chat works",
      ],
      media: {
        type: "story",
        sceneId: "cli",
        showCompanions: true,
        aspect: "2.03",
      },
    },
  ],
  faqs: [
    {
      question: "Does the agent act on its own?",
      answer:
        "No. It asks for approval before it acts, and it shows a source preview for what it reads, so you can follow and confirm each step.",
    },
    {
      question: "How do I add new capabilities?",
      answer:
        "Through skills (reusable prompts and tool definitions) and external connectors that are MCP-compatible. Both extend what the agent can reach without changing the chat itself.",
    },
    {
      question: "Where do its answers come from?",
      answer:
        "From your matters, files, registries, and connected tools. AI features are bring-your-own-key, and answers are grounded by citations back to the source.",
    },
  ],
  adjacent: [
    {
      title: "Tabular Review",
      href: "/product/tabular-review",
      body: "Turn a document set into a matter-scoped table you can sort, filter, and trace.",
    },
    {
      title: "Workspace",
      href: "/product/workspace",
      body: "Matters, documents, .docx editing, review, and chat in one workspace.",
    },
    {
      title: "Public data",
      href: "/product/public-data",
      body: "Read and search official case law, legal sources, and company registries.",
    },
    {
      title: "AI fact sheet",
      href: "/ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  evidence: [
    { type: "capability", id: "chat.get-messages" },
    { type: "capability", id: "skills.list" },
    { type: "capability", id: "catalogue.list-catalogue" },
    {
      type: "source",
      path: "apps/api/src/handlers/chat/send-message.ts",
      contains: ["export default sendMessage"],
    },
  ],
  cta: {
    heading: "Put the agent to work on your next matter.",
    href: "https://my.stll.app",
    label: "Start free",
  },
};
