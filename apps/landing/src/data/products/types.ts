// Shared shape for product pages. One template (src/pages/product/[slug].astro)
// renders any Product, so a new page is a data file, not new markup.

import type { ProductPreviewKey } from "../../components/react/previews/keys";
import type { ProductStorySceneId } from "../product-story";

// Media is a discriminated union. `story` reuses a deterministic product scene
// on the homepage and product pages; small menu cards use its theme-aware capture
// fallback. `preview` remains available for component illustrations elsewhere.
// A `video` may omit `poster`, and ProductMediaFrame falls back to a skeleton
// until its file exists on disk. `aspect` is a CSS aspect-ratio value.
export type ProductMedia =
  | { type: "preview"; key: ProductPreviewKey; aspect?: string }
  | {
      type: "story";
      sceneId: ProductStorySceneId;
      showCompanions?: boolean;
      aspect?: string;
    }
  | { type: "placeholder"; note: string; aspect?: string }
  | {
      type: "image";
      src: string;
      darkSrc: string;
      alt: string;
      aspect?: string;
    }
  | {
      type: "video";
      src: string;
      poster?: string;
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

export type ProductEvidence =
  | { type: "capability"; id: string }
  | { type: "source"; path: string; contains: readonly string[] };

export type Product = {
  slug: string;
  eyebrow: string;
  title: string;
  summary: string;
  /**
   * SERP title, topic-first with the brand suffix, kept at 60 characters or
   * fewer. Falls back to `stella | ${eyebrow}` when absent.
   */
  metaTitle?: string;
  /**
   * SERP description, 140-158 characters distilled from `summary` with the
   * same claims. Falls back to `summary` when absent.
   */
  metaDescription?: string;
  hero: ProductMedia;
  quickAnswer: ProductFaq;
  capabilities: readonly ProductCapability[];
  sections: readonly ProductSection[];
  faqs: readonly ProductFaq[];
  adjacent: readonly ProductLink[];
  evidence: readonly ProductEvidence[];
  cta: { heading: string; href: string; label: string };
};
