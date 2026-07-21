import { frameAccents, type Product } from "./types";

export const editor: Product = {
  slug: "editor",
  eyebrow: "Editor",
  title: "Edit Word documents without leaving the matter.",
  summary:
    "Open and edit Word .docx files directly in stella. The browser editor preserves the document format and its track changes, keeps the file connected to its matter, and saves each revision into the document's version history.",
  metaTitle: "Legal DOCX editor in the browser | stella",
  metaDescription:
    "Open and edit Word .docx files in the browser. The editor preserves the format, renders track changes, keeps the file in its matter, and versions each save.",
  hero: {
    type: "story",
    sceneId: "editor",
    aspect: "16 / 10",
  },
  // Frame rhythm down the page: bloom, ripple, bloom.
  heroFrameVariant: "bloom",
  frameAccent: frameAccents.iris,
  quickAnswer: {
    question: "Can I edit Word documents in stella?",
    answer:
      "Yes. Open a .docx file from a matter and edit it in the browser. stella keeps the document in its original Word format and records saved revisions in the same document's version history.",
  },
  capabilities: [
    {
      title: "Native .docx editing",
      body: "Work on Word documents in the browser instead of converting them into a separate proprietary format.",
    },
    {
      title: "Track changes",
      body: "Tracked insertions and deletions render in place, and AI-proposed edits arrive as tracked changes you accept or reject in the document.",
    },
    {
      title: "Matter context stays visible",
      body: "The document remains attached to its matter, alongside its files, properties, tasks, and conversations.",
    },
    {
      title: "Versioned saves",
      body: "Saved edits become document revisions, so the current file and its history stay together.",
    },
    {
      title: "Local Office bridge",
      body: "Use the desktop bridge when a document needs Microsoft Word, then return the updated file to the same matter.",
    },
  ],
  sections: [
    {
      heading: "The .docx stays a .docx",
      bullets: [
        "Open a .docx directly from a matter",
        "Edit the document with familiar page and formatting controls",
        "Review track changes in place, including edits proposed by AI",
        "Keep the original Word file format",
        "Save changes into the document's version history",
      ],
      media: {
        type: "story",
        sceneId: "editor",
        variant: "portrait",
        aspect: "16 / 10",
      },
      frameVariant: "ripple",
    },
    {
      heading: "Connected to the rest of the matter",
      bullets: [
        "Move between the document and its matter without uploading copies",
        "Keep document properties and revisions with the file",
        "Open the same document through the desktop bridge when needed",
        "Use the document as context for matter-aware tools",
      ],
      media: {
        type: "story",
        sceneId: "workspace",
        aspect: "16 / 10",
      },
      frameVariant: "bloom",
    },
  ],
  faqs: [
    {
      question: "Does stella convert the document to another format?",
      answer:
        "No. The browser editor works with the .docx document and saves the result back as a Word file.",
    },
    {
      question: "Does the editor support track changes?",
      answer:
        "Yes. Tracked insertions and deletions render in place, the way Word shows them. When stella's AI proposes edits, they arrive as tracked changes you accept or reject before they become part of the document.",
    },
    {
      question: "Can I still edit in Microsoft Word?",
      answer:
        "Yes. The stella desktop bridge supports local Office editing when you need Word-specific workflows.",
    },
    {
      question: "What happens when I save?",
      answer:
        "The saved file remains connected to the same matter and document, with revisions available through its version history.",
    },
  ],
  adjacent: [
    {
      title: "Workspace",
      href: "/product/workspace",
      body: "See where matters, documents, and tools live together.",
    },
    {
      title: "Templates",
      href: "/product/templates",
      body: "Create reusable Word documents with fields and conditional clauses.",
    },
    {
      title: "Tabular Review",
      href: "/product/tabular-review",
      body: "Turn a document set into a matter-scoped review table.",
    },
    {
      title: "AI fact sheet",
      href: "/ai-info",
      body: "stella in machine-readable form for AI search engines.",
    },
  ],
  evidence: [
    {
      type: "source",
      path: "apps/web/src/routes/_protected.workspaces/$workspaceId/$viewId.document.tsx",
      contains: ["DocxBrowserEditor", "app-docx-editor"],
    },
    {
      type: "source",
      path: "apps/web/src/components/ai-suggestions/docx-suggestion-persistence.ts",
      contains: ["resolveDocxSuggestionRequest", "revertDocxSuggestionRequest"],
    },
    { type: "capability", id: "entities.read-versions" },
  ],
  cta: {
    heading: "Edit a Word document in its matter.",
    href: "https://my.stll.app",
    label: "Start free",
  },
};
