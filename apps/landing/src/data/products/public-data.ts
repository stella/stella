import { frameAccents, productCtaLabels, type Product } from "./types";

export const publicData = {
  slug: "public-data",
  hero: {
    type: "image",
    src: "/media/products/public-data.png",
    darkSrc: "/media/products/public-data-dark.png",
    alt: "A court decision open in the stella case-law reader",
    aspect: "16 / 10",
  },
  heroFrameVariant: "bloom",
  frameAccent: frameAccents.tide,
  adjacent: {
    "product:anonymization": { to: "product", slug: "anonymization" },
    "product:agent": { to: "product", slug: "agent" },
    "product:tabular-review": { to: "product", slug: "tabular-review" },
    "ai-info": { to: "ai-info" },
  },
  evidence: [
    { type: "capability", id: "case-law.analysis.generate" },
    { type: "capability", id: "legislation.search" },
    { type: "capability", id: "contacts.business-registries-lookup" },
    {
      type: "source",
      path: "packages/legal-atlas/src/runners/registry.ts",
      contains: [
        "export const RUNNER_NAMES",
        "export const getRunnerDefinitions",
      ],
    },
    {
      type: "source",
      path: "packages/business-registries/src/index.ts",
      contains: [
        "./ares/index.js",
        "./companies-house/index.js",
        "./edgar/index.js",
        "./krs/index.js",
        "./prh/index.js",
        "./vies/index.js",
      ],
    },
  ],
  cta: {
    href: "https://my.stll.app",
    label: productCtaLabels.startFree,
  },
} satisfies Product<"public-data">;
