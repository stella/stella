import { frameAccents, type Product } from "./types";

export const editor: Product = {
  slug: "editor",
  eyebrow: "Editor",
  title: "Edit Word documents in the browser, without leaving the matter.",
  summary:
    "Open and edit Word .docx files right in your browser: no install, no converting to another format. stella's online DOCX editor preserves the original formatting and track changes, keeps the file connected to its matter, and saves each revision into the document's version history.",
  metaTitle: "Online DOCX Editor with Track Changes | stella",
  metaDescription:
    "Edit Word .docx documents in the browser: no install, no format conversion. stella's online DOCX editor preserves formatting and track changes, in the matter.",
  hero: {
    type: "live-editor",
    alt: "stella · Editor — live demo",
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
      title: "Edit .docx files in the browser",
      body: "Open and edit Word documents directly in stella's online editor: no install, and no converting the file into a separate proprietary format.",
    },
    {
      title: "Formatting stays intact",
      body: "The document stays a .docx throughout, so fonts, styles, and layout render and save the way Word created them.",
    },
    {
      title: "Track changes",
      body: "Tracked insertions and deletions render in place, and AI-proposed edits arrive as tracked changes you accept or reject in the document.",
    },
    {
      title: "Version history for every save",
      body: "Saved edits become document revisions, so the current file and its full history stay together.",
    },
    {
      title: "Matter context stays visible",
      body: "The document remains attached to its matter, alongside its files, properties, tasks, and conversations.",
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
      question: "Can I edit Word documents in the browser?",
      answer:
        "Yes. Open a .docx file from a matter and edit it directly in stella, in the browser: no download, no separate desktop app required.",
    },
    {
      question: "Is my formatting preserved?",
      answer:
        "Yes. The document stays a .docx throughout, so fonts, styles, and page layout render and save the way Word created them.",
    },
    {
      question: "Does stella convert the document to another format?",
      answer:
        "No. The browser editor works with the .docx document and saves the result back as a Word file.",
    },
    {
      question: "Does the editor keep track changes?",
      answer:
        "Yes. Tracked insertions and deletions render in place, the way Word shows them. When stella's AI proposes edits, they arrive as tracked changes you accept or reject before they become part of the document.",
    },
    {
      question: "Do I need Microsoft Word?",
      answer:
        "No. The browser editor handles .docx files directly, so Microsoft Word is not required. The stella desktop bridge is still there for local Office editing when you need Word-specific workflows.",
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
