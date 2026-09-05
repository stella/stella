import { frameAccents, productCtaLabels, type Product } from "./types";

export const anonymization = {
  slug: "anonymization",
  hero: {
    type: "live-anonymize",
    alt: "stella · Anonymization — live demo",
    aspect: "16 / 10",
  },
  heroFrameVariant: "ripple",
  frameAccent: frameAccents.tide,
  adjacent: {
    "product:agent": { to: "product", slug: "agent" },
    "product:workspace": { to: "product", slug: "workspace" },
    "product:tabular-review": { to: "product", slug: "tabular-review" },
    "ai-info": { to: "ai-info" },
  },
  evidence: [
    {
      type: "capability",
      id: "organization-settings.read-anonymization-blacklist",
    },
    {
      type: "capability",
      id: "matters.anonymization-terms.list",
    },
    {
      type: "source",
      path: "packages/anonymize-chat/src/index.ts",
      contains: [
        "export const runChatAnonPipeline",
        "export const CHAT_SEND_MODE",
      ],
    },
  ],
  cta: {
    href: "https://my.stll.app",
    label: productCtaLabels.startFree,
  },
} satisfies Product<"anonymization">;
