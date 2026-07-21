import { frameAccents, type Product } from "./types";

// Claims stay anchored to the shared WASM-backed anonymization pipeline and
// the product surfaces that expose it.
export const anonymization: Product = {
  slug: "anonymization",
  eyebrow: "Anonymization",
  title: "Prepare material for AI without exposing identifying details.",
  summary:
    "Remove names, entities, and identifying details before material reaches AI. Anonymization runs in your browser, directly from chat and document review, so unredacted text never leaves your machine.",
  metaTitle: "Document anonymization for legal AI | stella",
  metaDescription:
    "Remove names, entities, and identifying details before material reaches AI. Runs in the browser from chat and review; unredacted text stays on your machine.",
  hero: {
    type: "image",
    src: "/media/products/anonymization.png",
    darkSrc: "/media/products/anonymization-dark.png",
    alt: "A redacted legal due diligence extract open in stella",
    aspect: "16 / 10",
  },
  // Frame rhythm down the page: ripple, bloom, wash.
  heroFrameVariant: "ripple",
  frameAccent: frameAccents.tide,
  quickAnswer: {
    question: "What is anonymization in stella?",
    answer:
      "It removes names, entities, and identifying details before material enters an AI workflow. Anonymization runs in your browser, so unredacted text never leaves your machine, and it is integrated directly into chat and document review.",
  },
  capabilities: [
    {
      title: "Keeps identifying details out",
      body: "Removes names, entities, and identifying details before material reaches an AI step.",
    },
    {
      title: "Works in chat and review",
      body: "Runs directly in the chat composer and in document review, not in a separate tool.",
    },
    {
      title: "Nothing leaves your machine",
      body: "Anonymization runs in your browser; material is never sent anywhere to be redacted.",
    },
    {
      title: "Reviewable output",
      body: "Shows the redacted document in context, so you confirm what leaves the matter.",
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
      frameVariant: "bloom",
    },
    {
      heading: "Part of the workspace, not a separate tool",
      bullets: [
        "Available from chat and document review",
        "No copy-pasting into an external redaction tool",
        "Runs in your browser on stella's own open-source engine",
      ],
      media: {
        type: "story",
        sceneId: "workspace",
        aspect: "16 / 10",
      },
      frameVariant: "wash",
    },
  ],
  faqs: [
    {
      question: "Is anonymization available now?",
      answer:
        "Yes. Anonymization is available today, integrated in chat and document review.",
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
      id: "workspaces.anonymization-terms.read",
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
    heading: "Keep identifying details out of your AI workflows.",
    href: "https://my.stll.app",
    label: "Start free",
  },
};
