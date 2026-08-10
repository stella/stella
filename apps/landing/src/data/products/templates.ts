import { frameAccents, productCtaLabels, type Product } from "./types";

export const templates = {
  slug: "templates",
  hero: {
    type: "story",
    sceneId: "templates",
    aspect: "16 / 10",
  },
  // Frame rhythm down the page: ripple, bloom, wash, bloom.
  heroFrameVariant: "ripple",
  frameAccent: frameAccents.ember,
  sectionPresentations: {
    "author-from-templates": {
      media: {
        type: "preview",
        key: "template-editor",
      },
      frameVariant: "bloom",
    },
    "fill-from-matter": {
      media: {
        type: "story",
        sceneId: "template-fill",
        aspect: "16 / 10",
      },
      frameVariant: "wash",
    },
    "finish-in-editor": {
      media: {
        type: "story",
        sceneId: "editor",
        aspect: "16 / 10",
      },
      frameVariant: "bloom",
    },
  },
  adjacent: {
    "product:workspace": { to: "product", slug: "workspace" },
    "product:tabular-review": { to: "product", slug: "tabular-review" },
    "product:agent": { to: "product", slug: "agent" },
    "ai-info": { to: "ai-info" },
  },
  evidence: [
    { type: "capability", id: "templates.fill" },
    { type: "capability", id: "templates.suggest-fields" },
    { type: "capability", id: "clauses.list" },
    { type: "capability", id: "playbooks.run" },
  ],
  cta: {
    href: "https://my.stll.app",
    label: productCtaLabels.startFree,
  },
} satisfies Product<"templates">;
