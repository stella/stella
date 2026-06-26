// Shared shape for product pages. One template (src/pages/product/[slug].astro)
// renders any Product, so a new page is a data file, not new markup.

import type { ProductPreviewKey } from "../../components/react/previews/keys";

// Media is a discriminated union. `preview` renders a live, component-assembled
// mock UI by key (no screenshot to maintain — it re-renders from tokens); the
// others carry a static image/video or a stubbed placeholder. `aspect` is a CSS
// aspect-ratio value.
export type ProductMedia =
  | { type: "preview"; key: ProductPreviewKey; aspect?: string }
  | { type: "placeholder"; note: string; aspect?: string }
  | { type: "image"; src: string; alt: string; aspect?: string }
  | {
      type: "video";
      src: string;
      poster: string;
      alt: string;
      aspect?: string;
    };

export type ProductCapability = { title: string; body: string };

export type ProductSection = {
  heading: string;
  bullets: readonly string[];
  media: ProductMedia;
};

export type ProductFaq = { question: string; answer: string };

export type ProductLink = { title: string; href: string; body: string };

export type Product = {
  slug: string;
  eyebrow: string;
  title: string;
  summary: string;
  hero: ProductMedia;
  quickAnswer: ProductFaq;
  capabilities: readonly ProductCapability[];
  sections: readonly ProductSection[];
  faqs: readonly ProductFaq[];
  adjacent: readonly ProductLink[];
  cta: { heading: string; href: string; label: string };
};
