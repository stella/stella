import { frameAccents, productCtaLabels, type Product } from "./types";

export const editor: Product = {
  slug: "editor",
  eyebrow: "Editor",
  title: "Edit Word documents in the browser, without leaving the matter.",
  summary:
    "Open and edit Word .docx files right in your browser: no install, no converting to another format. stella's online DOCX editor preserves the original formatting and track changes, keeps the file connected to its matter, and saves each revision into the document's version history.",
  // SERP intent for this page is the workspace one: a document inside its
  // matter, with review and revisions. The tool queries ("edit docx online",
  // "docx editor without Word") belong to /docx-editor, whose meta, FAQ set,
  // and structured data are kept disjoint from this page's on purpose.
  metaTitle: "Editing Word Documents in Your Legal Workspace | stella",
  metaDescription:
    "Edit a matter's Word documents inside stella: track changes reviewed in place, a revision in the version history for every save, and a bridge to local Word.",
  hero: {
    type: "live-editor",
    alt: "stella · Editor — live demo",
    aspect: "16 / 11",
  },
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
    },
    {
      heading: "Connected to the rest of the matter",
      bullets: [
        "Move between the document and its matter without uploading copies",
        "Keep document properties and revisions with the file",
        "Open the same document through the desktop bridge when needed",
        "Use the document as context for matter-aware tools",
      ],
    },
  ],
  // Workspace-intent questions only. The tool-intent ones (do I need Word, is
  // my file uploaded, is formatting preserved, is it free) live on
  // /docx-editor; no question appears on both pages.
  faqs: [
    {
      question: "Does the document stay attached to its matter while I edit?",
      answer:
        "Yes. The document is edited where it lives, alongside the matter's other files, properties, tasks, and conversations, so no local copy is downloaded and re-uploaded to make a change.",
    },
    {
      question: "Does the editor keep track changes?",
      answer:
        "Yes. Tracked insertions and deletions render in place, the way Word shows them. Edits proposed by stella's AI arrive the same way, so a redline is reviewed and accepted or rejected before it becomes part of the document.",
    },
    {
      question: "What happens when I save?",
      answer:
        "The saved file remains connected to the same matter and document, and the save becomes a revision in that document's version history.",
    },
    {
      question: "Can I get back to an earlier revision?",
      answer:
        "Yes. Saved revisions stay in the document's version history, so the current file and the ones it replaced remain together on the same document.",
    },
    {
      question: "Can I open the same document in Microsoft Word?",
      answer:
        "Yes. The stella desktop bridge opens the document in local Office for Word-specific workflows and returns the edited file to the same matter.",
    },
    {
      question: "Can stella's AI work on the document I am editing?",
      answer:
        "Yes. The document is part of its matter's context, so matter-aware tools can read it and propose edits as tracked changes in the same document.",
    },
  ],
  adjacent: [
    {
      to: "product",
      slug: "workspace",
      body: "See where matters, documents, and tools live together.",
    },
    {
      to: "product",
      slug: "templates",
      body: "Create reusable Word documents with fields and conditional clauses.",
    },
    {
      to: "docx-editor",
      body: "Try the same editor on its own: open and edit a .docx in the browser, no account needed.",
    },
    {
      to: "ai-info",
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
    label: productCtaLabels.startFree,
  },
};
