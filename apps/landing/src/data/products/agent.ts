import { frameAccents, productCtaLabels, type Product } from "./types";

// The hero reuses the same agent scene as the opening product story.
export const agent = {
  slug: "agent",
  hero: {
    type: "story",
    sceneId: "agent",
    aspect: "16 / 10",
  },
  heroFrameVariant: "bloom",
  frameAccent: frameAccents.ember,
  adjacent: {
    "product:tabular-review": { to: "product", slug: "tabular-review" },
    "product:workspace": { to: "product", slug: "workspace" },
    "product:public-data": { to: "product", slug: "public-data" },
    "ai-info": { to: "ai-info" },
  },
  evidence: [
    { type: "capability", id: "chat.get-messages" },
    { type: "capability", id: "skills.list" },
    { type: "capability", id: "catalogue.list-catalogue" },
    {
      type: "source",
      path: "apps/api/src/handlers/chat/send-message.ts",
      contains: ["export default sendMessage"],
    },
    {
      type: "source",
      path: "apps/web/src/components/inspector/inspector-command-slice.ts",
      contains: ["requestBlockScroll"],
    },
    {
      type: "source",
      path: "apps/web/src/components/docx/use-docx-block-scroll.ts",
      contains: ["exact-passage"],
    },
  ],
  cta: {
    href: "https://my.stll.app",
    label: productCtaLabels.startFree,
  },
} satisfies Product<"agent">;
