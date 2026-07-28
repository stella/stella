// Shared shape for product pages. One template (src/pages/product/[slug].astro)
// renders any Product, so a new page is a data file, not new markup.

import type { ProductPreviewKey } from "../../components/react/previews/keys";
import type { TranslationKey } from "../../i18n/utils";
import type { ProductStorySceneId } from "../product-story";
import type { ProductSlug } from "./pillars";

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
      /** With companions shown, set false to drop the Teams + Editor side
       *  windows and keep just the CLI terminal + main stella window. */
      sideWindows?: boolean;
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
    }
  | {
      /** Live, in-browser run of the real anonymization engine (AnonymizeLiveDemo):
       *  an editable paragraph whose detected entities highlight as the WASM
       *  pipeline re-runs client-side. No server call; see ProductMediaFrame. */
      type: "live-anonymize";
      alt: string;
      aspect?: string;
    }
  | {
      /** Live, in-browser run of the real folio DOCX editor (EditorLiveDemo):
       *  a sample contract opens pre-parsed (no server round-trip) and is
       *  fully editable, including folio's own formatting toolbar and
       *  track-changes toggle. Mounted with `client:only` (not
       *  `client:visible`, unlike `live-anonymize`): folio's `DocxEditor`
       *  has no SSR guard and crashes under Astro's server render for a
       *  `document`-seeded editor; see ProductMediaFrame and
       *  EditorLiveDemo's doc comment. */
      type: "live-editor";
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
  /** Optional: omit for a text-only section (heading + bullets, no screen). */
  media?: ProductMedia;
  /** Frame recipe for this section's media frame; dormant, see `FrameVariant`. */
  frameVariant?: FrameVariant;
};

export type ProductFaq = { question: string; answer: string };

/**
 * An "Explore more" card. The card's title is the destination's own name, so
 * it is not stored here: a product card takes `nav.products.<slug>.eyebrow`,
 * the two standalone pages take their nav label. That makes a card that names
 * its destination differently from the destination itself unrepresentable,
 * and leaves only the one-line `body` as this page's own copy. `to` also says
 * whether the destination is localized: product pages are, the standalone
 * `/ai-info` and `/docx-editor` pages are English-only.
 */
export type ProductLink =
  | { to: "product"; slug: ProductSlug; body: string }
  | { to: "ai-info"; body: string }
  | { to: "docx-editor"; body: string };

/**
 * CTA button labels. They are shared across pages (seven of eight say the same
 * thing), so they live in the catalog under `common.*` and are referenced by
 * key; `en` mirrors the catalog value so the data file still reads as the
 * English source, and menu-copy.test.ts keeps the pair honest.
 */
export const productCtaLabels = {
  startFree: { key: "common.startFree", en: "Start free" },
  getCli: { key: "common.getCli", en: "Get the CLI" },
} as const satisfies Record<string, { key: TranslationKey; en: string }>;

export type ProductCtaLabel =
  (typeof productCtaLabels)[keyof typeof productCtaLabels];

export type ProductEvidence =
  | { type: "capability"; id: string }
  | { type: "source"; path: string; contains: readonly string[] };

export type Product = {
  slug: ProductSlug;
  eyebrow: string;
  title: string;
  summary: string;
  /**
   * SERP title, topic-first with the brand suffix, kept at 60 characters or
   * fewer.
   */
  metaTitle: string;
  /**
   * SERP description, 140-158 characters distilled from `summary` with the
   * same claims.
   */
  metaDescription: string;
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
  cta: { heading: string; href: string; label: ProductCtaLabel };
};
