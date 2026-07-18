import type { Product } from "./types";

// Claims stay anchored to the shared WASM-backed anonymization pipeline and
// the product surfaces that expose it.
export const anonymization: Product = {
  slug: "anonymization",
  eyebrow: "Anonymization",
  title: "Prepare material for AI without exposing identifying details.",
  summary:
    "WASM-backed anonymization for legal AI workflows. Prepare material without exposing names, entities, or identifying details, directly from chat and document review.",
  hero: {
    type: "image",
    src: "/media/products/anonymization.png",
    darkSrc: "/media/products/anonymization-dark.png",
    alt: "A redacted legal due diligence extract open in stella",
    aspect: "16 / 10",
  },
  quickAnswer: {
    question: "What is anonymization in stella?",
    answer:
      "WASM-backed tooling that prepares material for AI workflows without exposing names, entities, or identifying details. It is integrated directly into chat and document review.",
  },
  capabilities: [
    {
      title: "Built for legal AI workflows",
      body: "Helps prepare material before it reaches an AI step.",
    },
    {
      title: "Keeps identifying details out",
      body: "Removes names, entities, and identifying details before material reaches AI.",
    },
    {
      title: "WASM-backed",
      body: "Runs on WASM-backed anonymization tooling.",
    },
    {
      title: "Works in chat",
      body: "Integrated through chat, so it fits the flow you already use.",
    },
    {
      title: "Works in review",
      body: "Integrated through document review alongside your files.",
    },
    {
      title: "Reviewable output",
      body: "Shows the redacted document in context before it moves into the next workflow step.",
    },
  ],
  sections: [
    {
      heading: "Prepare material before it reaches AI",
      bullets: [
        "Keeps names, entities, and identifying details out of AI steps",
        "Built for legal AI workflows rather than generic document masking",
        "Leaves a reviewable redacted document before the next step",
      ],
      media: {
        type: "preview",
        key: "anonymization",
      },
    },
    {
      heading: "Integrated where you already work",
      bullets: [
        "Reaches you through chat and document review",
        "Fits the existing workspace rather than a separate tool",
        "Built on WASM-backed anonymization tooling",
      ],
      media: {
        type: "image",
        src: "/media/products/anonymization.png",
        darkSrc: "/media/products/anonymization-dark.png",
        alt: "A redacted due diligence extract open in the stella editor",
        aspect: "16 / 10",
      },
    },
  ],
  faqs: [
    {
      question: "Is anonymization available now?",
      answer:
        "Yes. The WASM-backed anonymization pipeline is available through chat and document review.",
    },
    {
      question: "What does it help with?",
      answer:
        "Preparing material for AI workflows without exposing names, entities, or identifying details, while keeping the redacted result available for review.",
    },
  ],
  adjacent: [
    {
      title: "AI agent",
      href: "/product/agent",
      body: "Chat across matters, files, and connected tools with approvals and source previews.",
    },
    {
      title: "Workspace",
      href: "/product/workspace",
      body: "Matters, documents, .docx editing, review, and chat in one workspace.",
    },
    {
      title: "Tabular Review",
      href: "/product/tabular-review",
      body: "Turn a document set into a matter-scoped table you can sort, filter, and trace.",
    },
    {
      title: "AI fact sheet",
      href: "/ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  evidence: [
    {
      type: "capability",
      id: "organization-settings.read-anonymization-blacklist",
    },
    {
      type: "capability",
      id: "workspaces.anonymization-terms.readWorkspaceAnonymizationTerms",
    },
    {
      type: "source",
      path: "packages/anonymize-chat/src/index.ts",
      contains: [
        "export const runChatAnonPipeline",
        "export const CHAT_SEND_MODE",
      ],
    },
  ],
  cta: {
    heading: "Prepare sensitive material before it reaches AI.",
    href: "https://my.stll.app",
    label: "Start free",
  },
};
