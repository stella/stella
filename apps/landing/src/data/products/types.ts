// Shared shape for product pages. One template (src/pages/product/[slug].astro)
// renders any Product, so a new page is a data file, not new markup.

// Media is a discriminated union so a section can carry a stubbed placeholder
// now and swap to an auto-captured screenshot — or later an animation/video —
// without touching the template. `aspect` is a CSS aspect-ratio value.
export type ProductMedia =
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
