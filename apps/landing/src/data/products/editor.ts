import { frameAccents, productCtaLabels, type Product } from "./types";

export const editor = {
  slug: "editor",
  hero: {
    type: "live-editor",
    alt: "stella · Editor — live demo",
    aspect: "16 / 11",
  },
  heroFrameVariant: "bloom",
  frameAccent: frameAccents.iris,
  adjacent: {
    "product:workspace": { to: "product", slug: "workspace" },
    "product:templates": { to: "product", slug: "templates" },
    "docx-editor": { to: "docx-editor" },
    "ai-info": { to: "ai-info" },
  },
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
    href: "https://my.stll.app",
    label: productCtaLabels.startFree,
  },
} satisfies Product<"editor">;
