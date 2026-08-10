// Shared shape for product pages. One template (src/pages/product/[slug].astro)
// renders any Product, so a new page is a data file, not new markup.

import type { ProductPreviewKey } from "../../components/react/previews/keys";
import type Messages from "../../i18n/messages/messages.gen";
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
      /** Optional mobile ratio for scenes whose windows recompose vertically. */
      mobileAspect?: string;
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
      /** In-browser presentation of the real folio DOCX editor: mobile uses
       *  a non-interactive, theme-aware capture because the scaled controls
       *  are too small for touch; larger viewports mount EditorLiveDemo, where
       *  a sample contract is fully editable, including folio's formatting
       *  toolbar and track-changes toggle. Mounted with `client:only` (not
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

export type ProductSectionPresentation = {
  media: ProductMedia;
  /** Frame recipe for this section's media frame; dormant, see `FrameVariant`. */
  frameVariant?: FrameVariant;
};

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
  | { to: "product"; slug: ProductSlug }
  | { to: "ai-info" }
  | { to: "docx-editor" };

type ProductLinkId =
  | `product:${ProductSlug}`
  | Exclude<ProductLink["to"], "product">;

type ProductLinkForId<TId extends ProductLinkId> =
  TId extends `product:${infer TSlug extends ProductSlug}`
    ? { to: "product"; slug: TSlug }
    : TId extends "ai-info"
      ? { to: "ai-info" }
      : { to: "docx-editor" };

/**
 * CTA button labels live in the catalog under `common.*`; product data stores
 * only the translation key.
 */
export const productCtaLabels = {
  startFree: "common.startFree",
  getCli: "common.getCli",
} as const satisfies Record<string, TranslationKey>;

export type ProductCtaLabel =
  (typeof productCtaLabels)[keyof typeof productCtaLabels];

export type ProductEvidence =
  | { type: "capability"; id: string }
  | { type: "source"; path: string; contains: readonly string[] };

/**
 * Agent-connection instructions. Prose renders from the catalog; client names
 * are brand constants and snippets are code, so both live here.
 */
type CliMcpSetupClientId =
  keyof Messages["products"]["cli-mcp"]["setup"]["clients"];

type NumericCliMcpSetupClientId = Extract<CliMcpSetupClientId, `${number}`>;

export type ProductSetup = {
  endpoint: string;
  clients: NumericCliMcpSetupClientId extends never
    ? Readonly<
        Record<
          CliMcpSetupClientId,
          { readonly name: string; readonly snippet?: string }
        >
      >
    : never;
  outroSnippet: string;
};

type ProductSectionId<TSlug extends ProductSlug> = {
  [TProductSlug in TSlug]: keyof Messages["products"][TProductSlug]["sections"];
}[TSlug] &
  string;

type StableProductSectionId<TSlug extends ProductSlug> = Exclude<
  ProductSectionId<TSlug>,
  `${number}`
>;

type CatalogAdjacentId<TSlug extends ProductSlug> =
  keyof Messages["products"][TSlug]["adjacent"] & string;

type InvalidCatalogAdjacentId<TSlug extends ProductSlug> = Exclude<
  CatalogAdjacentId<TSlug>,
  ProductLinkId
>;

type ProductAdjacentLinks<TSlug extends ProductSlug> = {
  readonly [TId in CatalogAdjacentId<TSlug> &
    ProductLinkId]: ProductLinkForId<TId>;
};

export type Product<TSlug extends ProductSlug> = {
  slug: TSlug;
  hero: ProductMedia;
  /** Frame recipe for the hero media frame; dormant, see `FrameVariant`. */
  heroFrameVariant?: FrameVariant;
  /**
   * Accent hue for this product's "bloom" frames, from `frameAccents`.
   * Dormant along with `FrameVariant`/`heroFrameVariant`/`frameVariant`.
   */
  frameAccent?: FrameAccent;
  /**
   * Optional visual treatments keyed by stable catalog section IDs. Numeric
   * catalog keys are excluded so reordering copy cannot move media silently.
   */
  sectionPresentations?: StableProductSectionId<TSlug> extends never
    ? never
    : Readonly<
        Record<StableProductSectionId<TSlug>, ProductSectionPresentation>
      >;
  setup?: ProductSetup;
  adjacent: InvalidCatalogAdjacentId<TSlug> extends never
    ? ProductAdjacentLinks<TSlug>
    : never;
  evidence: readonly ProductEvidence[];
  cta: { href: string; label: ProductCtaLabel };
};

export type AnyProduct = {
  [TSlug in ProductSlug]: Product<TSlug>;
}[ProductSlug];
