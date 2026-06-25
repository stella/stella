import type { Product } from "./types";

// Anonymization is actively in development; this page is a light, high-level
// scaffold. Screenshots are stubbed as placeholders, and each note describes a
// future seeded state to capture once the feature lands.
export const anonymization: Product = {
  slug: "anonymization",
  eyebrow: "Anonymization",
  title: "Prepare material for AI without exposing identifying details.",
  summary:
    "WASM-backed anonymization tooling for legal AI workflows. It helps prepare material for AI without exposing names, entities, or identifying details, integrated through chat and document review. This is actively being built: more is coming soon.",
  hero: {
    type: "placeholder",
    note: "Future seeded screenshot: a document with identifying details prepared for AI, integrated into review (capture once the feature ships)",
    aspect: "16 / 10",
  },
  quickAnswer: {
    question: "What is anonymization in stella?",
    answer:
      "WASM-backed tooling that helps prepare material for AI workflows without exposing names, entities, or identifying details. It is integrated through chat and document review. This feature is actively in development, so more detail is coming soon.",
  },
  capabilities: [
    {
      title: "Built for legal AI workflows",
      body: "Helps prepare material before it reaches an AI step.",
    },
    {
      title: "Keeps identifying details out",
      body: "Aims to avoid exposing names, entities, or identifying details to AI.",
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
      title: "Coming soon",
      body: "Actively in development; more capabilities are on the way.",
    },
  ],
  sections: [
    {
      heading: "Prepare material before it reaches AI",
      bullets: [
        "Helps keep names, entities, and identifying details out of AI steps",
        "Aimed at legal AI workflows rather than general redaction",
        "More detail is coming soon as the feature develops",
      ],
      media: {
        type: "placeholder",
        note: "Future seeded screenshot: a document being prepared for an AI step (capture once the feature ships)",
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
        type: "placeholder",
        note: "Future seeded screenshot: anonymization surfaced inside chat and review (capture once the feature ships)",
      },
    },
  ],
  faqs: [
    {
      question: "Is anonymization available now?",
      answer:
        "It is actively in development. The underlying tooling is WASM-backed and is integrated through chat and document review. More detail is coming soon.",
    },
    {
      question: "What does it help with?",
      answer:
        "Preparing material for AI workflows without exposing names, entities, or identifying details. We will share more specifics as the feature develops.",
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
  cta: {
    heading: "Follow anonymization as it lands in stella.",
    href: "https://my.stll.app",
    label: "Start free",
  },
};
