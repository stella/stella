import { frameAccents, productCtaLabels, type Product } from "./types";

// Claims stay anchored to the shared WASM-backed anonymization pipeline and
// the product surfaces that expose it.
export const anonymization: Product = {
  slug: "anonymization",
  eyebrow: "Anonymization",
  title: "Prepare material for AI without exposing identifying details.",
  summary:
    "Remove names, entities, and identifying details before material reaches AI, directly from chat and document review, with a redacted result you can check before anything moves on.",
  metaTitle: "Document anonymization for legal AI | stella",
  metaDescription:
    "Remove names, entities, and identifying details before material reaches AI, directly from chat and document review, with a redacted result you can check.",
  hero: {
    type: "live-anonymize",
    alt: "stella · Anonymization — live demo",
    aspect: "16 / 10",
  },
  heroFrameVariant: "ripple",
  frameAccent: frameAccents.tide,
  quickAnswer: {
    question: "What is anonymization in stella?",
    answer:
      "It removes names, entities, and identifying details before material enters an AI workflow, and shows you the redacted result so you can confirm what leaves the matter. It is integrated directly into chat and document review.",
  },
  capabilities: [
    {
      title: "Keeps identifying details out",
      body: "Removes names, entities, and identifying details before material reaches an AI step.",
    },
    {
      title: "Works in chat and review",
      body: "Runs directly in chat and in document review, not in a separate tool.",
    },
    {
      title: "Your terms included",
      body: "Add your organisation's own terms and name lists so the names that matter to you are always caught.",
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
    },
    {
      heading: "Part of the workspace, not a separate tool",
      bullets: [
        "Available from chat and document review",
        "No copy-pasting into an external redaction tool",
        "Built on stella's own open-source anonymization engine",
      ],
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
      to: "product",
      slug: "agent",
      body: "Chat across matters, files, and connected tools with approvals and source previews.",
    },
    {
      to: "product",
      slug: "workspace",
      body: "Matters, documents, .docx editing, review, and chat in one workspace.",
    },
    {
      to: "product",
      slug: "tabular-review",
      body: "Turn a document set into a table you can sort, filter, and trace back to the source.",
    },
    {
      to: "ai-info",
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
      id: "workspaces.anonymization-terms.list",
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
    label: productCtaLabels.startFree,
  },
};
