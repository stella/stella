import { frameAccents, productCtaLabels, type Product } from "./types";

// Templates shipped in 0.5.0. Part of the Legal-intelligence pillar: build
// reusable templates with fields and conditional clauses, and let AI fill them
// from a matter's data. Keep claims modest and factual; adjust copy to match
// the public 0.5.0 framing.
export const templates: Product = {
  slug: "templates",
  eyebrow: "Templates",
  title: "Build reusable templates, and let AI fill them in.",
  summary:
    "Define a template once with fields and conditional clauses, then fill it in by hand or let stella draft it from a matter's data. The finished document lands in the matter, ready to keep editing.",
  metaTitle: "Legal document templates with AI drafting | stella",
  metaDescription:
    "Define a template with fields and conditional clauses, then fill it by hand or let stella draft it from a matter's data. The draft lands in the matter.",
  hero: {
    type: "story",
    sceneId: "templates",
    aspect: "16 / 10",
  },
  // Frame rhythm down the page: ripple, bloom, wash, bloom.
  heroFrameVariant: "ripple",
  frameAccent: frameAccents.ember,
  quickAnswer: {
    question: "How do templates work in stella?",
    answer:
      "A template is a document with fields and clauses you can include conditionally. You fill the fields in by hand or let stella draft them from a matter's data; the right clauses are included, and you get a document to keep working on in the matter. Templates and clauses are reusable, so repeat documents start from a known-good base.",
  },
  capabilities: [
    {
      title: "Reusable templates",
      body: "Start repeat documents from a known-good base instead of a copied file.",
    },
    {
      title: "Fields and placeholders",
      body: "Define the values a document needs and fill them in when you assemble it.",
    },
    {
      title: "Conditional clauses",
      body: "Include or omit clauses based on the values you provide, so a template covers variants.",
    },
    {
      title: "Fill with AI",
      body: "Let stella draft a filled document from a matter's data, then refine it.",
    },
    {
      title: "Edit in place",
      body: "Author and adjust templates in the editor, then assemble from them.",
    },
    {
      title: "Into a matter",
      body: "The draft lands in the matter, ready to edit alongside the rest of the work.",
    },
  ],
  sections: [
    {
      heading: "Build from templates and clauses",
      bullets: [
        "Assemble a document from a template instead of starting blank",
        "Reuse clauses across templates",
        "Keep repeat documents consistent",
      ],
      media: {
        type: "preview",
        key: "template-editor",
      },
      frameVariant: "bloom",
    },
    {
      heading: "Fill it from the matter's data",
      bullets: [
        "Prefill fields from a document already stored in the matter",
        "Review and adjust every value before producing the draft",
        "Conditional clauses still follow the values you keep",
      ],
      media: {
        type: "story",
        sceneId: "template-fill",
        aspect: "16 / 10",
      },
      frameVariant: "wash",
    },
    {
      heading: "Edit and assemble in place",
      bullets: [
        "Author and adjust templates in the editor",
        "Assemble the draft directly in the matter",
        "Keep editing the result alongside the matter's files",
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
      question: "Can I edit a template?",
      answer:
        "Yes. Templates are authored and adjusted in the editor, then you assemble documents from them.",
    },
    {
      question: "What is a clause?",
      answer:
        "A reusable piece of a document. Clauses can be included across templates and added conditionally based on the values you provide when assembling.",
    },
    {
      question: "Where does the assembled document go?",
      answer:
        "Into a matter, as a draft you can keep editing alongside the rest of the matter's documents.",
    },
  ],
  adjacent: [
    {
      to: "product",
      slug: "workspace",
      body: "Matters, documents, and Word editing in one place.",
    },
    {
      to: "product",
      slug: "tabular-review",
      body: "Turn a document set into a review table in the matter.",
    },
    {
      to: "product",
      slug: "agent",
      body: "Chat across matters, files, and sources with citations.",
    },
    {
      to: "ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  evidence: [
    { type: "capability", id: "templates.fill" },
    { type: "capability", id: "templates.suggest-fields" },
    { type: "capability", id: "clauses.list" },
    { type: "capability", id: "playbooks.run" },
  ],
  cta: {
    heading: "Start from a template, not a blank page.",
    href: "https://my.stll.app",
    label: productCtaLabels.startFree,
  },
};
