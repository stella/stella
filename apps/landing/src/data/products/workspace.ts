import { frameAccents, productCtaLabels, type Product } from "./types";

export const workspace = {
  slug: "workspace",
  hero: {
    type: "story",
    sceneId: "workspace",
    aspect: "16 / 10",
  },
  // Frame rhythm down the page: bloom, wash, bloom.
  heroFrameVariant: "bloom",
  frameAccent: frameAccents.iris,
  sectionPresentations: {
    "matter-workspace": {
      media: {
        type: "story",
        sceneId: "review",
        aspect: "16 / 10",
      },
      frameVariant: "wash",
    },
    "word-documents": {
      media: {
        type: "story",
        sceneId: "editor",
        aspect: "16 / 10",
      },
      frameVariant: "bloom",
    },
  },
  adjacent: {
    "product:agent": { to: "product", slug: "agent" },
    "product:tabular-review": { to: "product", slug: "tabular-review" },
    "product:cli-mcp": { to: "product", slug: "cli-mcp" },
    "ai-info": { to: "ai-info" },
  },
  evidence: [
    { type: "capability", id: "matters.list" },
    { type: "capability", id: "entities.list" },
    { type: "capability", id: "entities.upload" },
    { type: "capability", id: "views.list" },
    { type: "capability", id: "entities.read-versions" },
    {
      type: "source",
      path: "apps/desktop/src/mainview/App.tsx",
      contains: ["const App = () =>", "export default App"],
    },
    {
      type: "source",
      path: "apps/web/src/routes/_protected.workspaces/$workspaceId/$viewId.document.tsx",
      contains: ["DocxBrowserEditor", "ReadOnlyDocxDocumentViewer"],
    },
    {
      type: "source",
      path: "apps/api/src/mcp/server-core.ts",
      contains: ["export const createMcpHttpRequestHandler"],
    },
  ],
  cta: {
    href: "https://my.stll.app",
    label: productCtaLabels.startFree,
  },
} satisfies Product<"workspace">;
