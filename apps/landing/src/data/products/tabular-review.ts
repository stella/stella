import { frameAccents, productCtaLabels, type Product } from "./types";

export const tabularReview = {
  slug: "tabular-review",
  hero: {
    type: "story",
    sceneId: "review",
    aspect: "16 / 10",
  },
  heroFrameVariant: "bloom",
  frameAccent: frameAccents.ember,
  adjacent: {
    "product:agent": { to: "product", slug: "agent" },
    "product:public-data": { to: "product", slug: "public-data" },
    "product:anonymization": { to: "product", slug: "anonymization" },
    "ai-info": { to: "ai-info" },
  },
  evidence: [
    { type: "capability", id: "views.list" },
    { type: "capability", id: "properties.list" },
    { type: "capability", id: "fields.upsert-by-id" },
    { type: "capability", id: "reports.export-view" },
  ],
  cta: {
    href: "https://my.stll.app",
    label: productCtaLabels.startFree,
  },
} satisfies Product<"tabular-review">;
