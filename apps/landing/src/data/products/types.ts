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
      /** "portrait" renders the full-page document capture (editor only)
       *  as a centred portrait window instead of the wide app scene. */
      variant?: "portrait";
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

// Frame recipes for ProductMediaFrame. DORMANT: product pages now use the
// homepage's frameless language (each media type paints its own window; see
// HomeProductStory's .story-window), so ProductMediaFrame no longer renders
// a glass ring and these recipes are visually inert. Kept on the data model,
// unchanged from when "wash" was the neutral diagonal glass gradient
// (default everywhere, including menu thumbnails), "bloom" added a
// low-percentage radial accent glow in the frame's end corner, and "ripple"
// laid a faint excerpt of the hero gradient artwork under the glass; a
// planned faint background-accent pass will decide what (if anything) these
// drive next, so don't delete them as dead data in the meantime.
export type FrameVariant = "wash" | "bloom" | "ripple";

// Accent hues reused from scenes and tokens that already exist in the landing;
// no invented colors. Keyed by pillar mood, applied per product.
export const frameAccents = {
  // Agent scene chip color (AGENT_ACCENT in CliMcpPreview).
  ember: "#d97757",
  // Teams companion window accent (--teams-accent in CliMcpPreview).
  iris: "#6264a7",
  // Terminal accent token (global.css).
  sky: "var(--terminal-accent)",
  // Theme-switched hero/auth gradient endpoint token (global.css).
  tide: "var(--auth-gradient-end)",
} as const;

export type FrameAccent = (typeof frameAccents)[keyof typeof frameAccents];

export type ProductCapability = { title: string; body: string };

export type ProductSection = {
  heading: string;
  bullets: readonly string[];
  media: ProductMedia;
  /** Frame recipe for this section's media frame; dormant, see `FrameVariant`. */
  frameVariant?: FrameVariant;
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
  /** Frame recipe for the hero media frame; dormant, see `FrameVariant`. */
  heroFrameVariant?: FrameVariant;
  /**
   * Accent hue for this product's "bloom" frames, from `frameAccents`.
   * Dormant along with `FrameVariant`/`heroFrameVariant`/`frameVariant`.
   */
  frameAccent?: FrameAccent;
  quickAnswer: ProductFaq;
  capabilities: readonly ProductCapability[];
  sections: readonly ProductSection[];
  faqs: readonly ProductFaq[];
  adjacent: readonly ProductLink[];
  evidence: readonly ProductEvidence[];
  cta: { heading: string; href: string; label: string };
};
