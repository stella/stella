import type { TranslationKey } from "./site-nav";

export const productStorySceneIds = [
  "workspace",
  "review",
  "review-citation",
  "editor",
  "agent",
  "cli",
  "templates",
  "template-fill",
] as const;

export type ProductStorySceneId = (typeof productStorySceneIds)[number];

export type ProductStoryMedia = {
  alt: string;
  darkPosterSrc: string;
  darkVideoSrc: string;
  posterSrc: string;
  videoSrc: string;
};

export type ProductStoryScene = {
  id: ProductStorySceneId;
  label: string;
  productSlug: "workspace" | "tabular-review" | "editor" | "agent" | "cli-mcp";
};

export const productStoryScenes = [
  { id: "workspace", label: "Matter", productSlug: "workspace" },
  { id: "review", label: "Review", productSlug: "tabular-review" },
  { id: "editor", label: "Editor", productSlug: "editor" },
  { id: "agent", label: "Agent", productSlug: "agent" },
  { id: "cli", label: "CLI & MCP", productSlug: "cli-mcp" },
] as const satisfies readonly ProductStoryScene[];

export type ProductStoryWindowId = "app" | "editor" | "teams" | "terminal";

/**
 * The scene windows a viewer can bring to front that are ours to name. The
 * Microsoft Teams companion is deliberately absent: its title is a third-party
 * proper noun, and so is its handle's accessible name.
 */
export type SceneWindowId = "workspace" | "source" | "terminal";

/**
 * Accessible names for those handles, resolved for one locale. `CliMcpPreview`
 * is a React island with no translator, so every Astro mount passes these in;
 * the prop is required, because a scene that renders the handles without them
 * would ship an English `aria-label` onto a localized page. Written out per
 * window for the same reason `resolveProductEyebrows` is: `satisfies` here
 * turns a new scene window into a typecheck error, not a silent English label.
 */
export const resolveSceneWindowLabels = (t: (key: TranslationKey) => string) =>
  ({
    workspace: t("story.bringWorkspaceToFront"),
    source: t("story.bringEditorToFront"),
    terminal: t("story.bringTerminalToFront"),
  }) satisfies Record<SceneWindowId, string>;

export type ProductStoryPlaybackStep = {
  id: string;
  durationMs: number;
  focus: ProductStoryWindowId;
  sceneId: ProductStorySceneId;
};

export const openingProductStory = [
  {
    id: "teams-request",
    durationMs: 1500,
    focus: "teams",
    sceneId: "workspace",
  },
  {
    id: "teams-answer",
    durationMs: 2200,
    focus: "teams",
    sceneId: "workspace",
  },
  {
    id: "open-matter",
    durationMs: 2000,
    focus: "app",
    sceneId: "workspace",
  },
  {
    id: "review-findings",
    durationMs: 2800,
    focus: "app",
    sceneId: "review",
  },
  {
    id: "edit-clause",
    durationMs: 2800,
    focus: "app",
    sceneId: "editor",
  },
  {
    id: "grounded-answer",
    durationMs: 3600,
    focus: "app",
    sceneId: "agent",
  },
  {
    id: "run-from-terminal",
    durationMs: 5200,
    focus: "terminal",
    sceneId: "cli",
  },
] as const satisfies readonly ProductStoryPlaybackStep[];

export const productStoryThumbnails = {
  workspace: {
    src: "/media/products/workspace.png",
    darkSrc: "/media/products/workspace-dark.png",
    alt: "Matter workspace in stella",
  },
  review: {
    src: "/media/products/tabular-review.png",
    darkSrc: "/media/products/tabular-review-dark.png",
    alt: "Contract review table in stella",
  },
  // Product-page-only scene (same product area as "review"); reuses its
  // thumbnail since nothing lists this scene by icon (nav mega-menu,
  // homepage chapters) the way "review" itself is.
  "review-citation": {
    src: "/media/products/tabular-review.png",
    darkSrc: "/media/products/tabular-review-dark.png",
    alt: "Contract review table in stella",
  },
  editor: {
    src: "/media/products/editor.png",
    darkSrc: "/media/products/editor-dark.png",
    alt: "Word document open in the stella Editor",
  },
  agent: {
    src: "/media/products/agent.png",
    darkSrc: "/media/products/agent-dark.png",
    alt: "AI agent in stella",
  },
  cli: {
    src: "/media/products/story-cli-poster.jpg",
    darkSrc: "/media/products/story-cli-dark-poster.jpg",
    alt: "The tools and capability catalogue in stella",
  },
  templates: {
    src: "/media/products/story-templates-poster.jpg",
    darkSrc: "/media/products/story-templates-dark-poster.jpg",
    alt: "A template with fields and conditional clauses in the stella template studio",
  },
  // Product-page-only scene (same product area as "templates"); reuses its
  // thumbnail since nothing lists this scene by icon.
  "template-fill": {
    src: "/media/products/story-templates-poster.jpg",
    darkSrc: "/media/products/story-templates-dark-poster.jpg",
    alt: "A template with fields and conditional clauses in the stella template studio",
  },
} as const satisfies Record<
  ProductStorySceneId,
  { alt: string; darkSrc: string; src: string }
>;

// Stella-owned surfaces are recorded from deterministic, seeded app routes by
// apps/web/e2e/marketing/record-product-story.ts. The homepage and product
// pages consume this one registry, so they cannot drift onto separate demos.
export const productStoryMedia = {
  workspace: {
    videoSrc: "/media/products/story-workspace.mp4",
    darkVideoSrc: "/media/products/story-workspace-dark.mp4",
    posterSrc: "/media/products/story-workspace-poster.jpg",
    darkPosterSrc: "/media/products/story-workspace-dark-poster.jpg",
    alt: "A seeded matter workspace open in stella",
  },
  review: {
    videoSrc: "/media/products/story-review.mp4",
    darkVideoSrc: "/media/products/story-review-dark.mp4",
    posterSrc: "/media/products/story-review-poster.jpg",
    darkPosterSrc: "/media/products/story-review-dark-poster.jpg",
    alt: "A contract review table running in stella",
  },
  "review-citation": {
    videoSrc: "/media/products/story-review-citation.mp4",
    darkVideoSrc: "/media/products/story-review-citation-dark.mp4",
    posterSrc: "/media/products/story-review-citation-poster.jpg",
    darkPosterSrc: "/media/products/story-review-citation-dark-poster.jpg",
    alt: "Clicking a cited table cell to open its source passage in stella",
  },
  editor: {
    videoSrc: "/media/products/story-editor.mp4",
    darkVideoSrc: "/media/products/story-editor-dark.mp4",
    posterSrc: "/media/products/story-editor-poster.jpg",
    darkPosterSrc: "/media/products/story-editor-dark-poster.jpg",
    alt: "A Word document being reviewed in the stella Editor",
  },
  agent: {
    videoSrc: "/media/products/story-agent.mp4",
    darkVideoSrc: "/media/products/story-agent-dark.mp4",
    posterSrc: "/media/products/story-agent-poster.jpg",
    darkPosterSrc: "/media/products/story-agent-dark-poster.jpg",
    alt: "A grounded answer with cited matter sources in stella",
  },
  cli: {
    videoSrc: "/media/products/story-cli.mp4",
    darkVideoSrc: "/media/products/story-cli-dark.mp4",
    posterSrc: "/media/products/story-cli-poster.jpg",
    darkPosterSrc: "/media/products/story-cli-dark-poster.jpg",
    alt: "The tools and capability catalogue in stella",
  },
  templates: {
    videoSrc: "/media/products/story-templates.mp4",
    darkVideoSrc: "/media/products/story-templates-dark.mp4",
    posterSrc: "/media/products/story-templates-poster.jpg",
    darkPosterSrc: "/media/products/story-templates-dark-poster.jpg",
    alt: "A template with fields and conditional clauses in the stella template studio",
  },
  "template-fill": {
    videoSrc: "/media/products/story-template-fill.mp4",
    darkVideoSrc: "/media/products/story-template-fill-dark.mp4",
    posterSrc: "/media/products/story-template-fill-poster.jpg",
    darkPosterSrc: "/media/products/story-template-fill-dark-poster.jpg",
    alt: "Filling a template from a matter's own documents with AI in stella",
  },
} as const satisfies Record<ProductStorySceneId, ProductStoryMedia>;

// Aspect-matched variants for the companion composition (CliMcpPreview with
// side windows): its main window content box is ~1.674:1, not 16:9, so these
// captures fill it without cropping. Scene-only embeds (product pages,
// HomeProductStory chapters) keep the 16:9 masters above. `cli` reuses the
// agent capture, mirroring productStoryMedia.
export const productStoryHeroMedia = {
  workspace: {
    videoSrc: "/media/products/story-workspace-hero.mp4",
    darkVideoSrc: "/media/products/story-workspace-hero-dark.mp4",
    posterSrc: "/media/products/story-workspace-hero-poster.jpg",
    darkPosterSrc: "/media/products/story-workspace-hero-dark-poster.jpg",
    alt: "A seeded matter workspace open in stella",
  },
  review: {
    videoSrc: "/media/products/story-review-hero.mp4",
    darkVideoSrc: "/media/products/story-review-hero-dark.mp4",
    posterSrc: "/media/products/story-review-hero-poster.jpg",
    darkPosterSrc: "/media/products/story-review-hero-dark-poster.jpg",
    alt: "A contract review table running in stella",
  },
  // Product-page section only; like templates below, this has a wide
  // capture only, so the hero record reuses it (object-cover crops
  // slightly in the companion composition, which never renders this scene
  // in practice — see productStoryScenes/openingProductStory).
  "review-citation": {
    videoSrc: "/media/products/story-review-citation.mp4",
    darkVideoSrc: "/media/products/story-review-citation-dark.mp4",
    posterSrc: "/media/products/story-review-citation-poster.jpg",
    darkPosterSrc: "/media/products/story-review-citation-dark-poster.jpg",
    alt: "Clicking a cited table cell to open its source passage in stella",
  },
  editor: {
    videoSrc: "/media/products/story-editor-hero.mp4",
    darkVideoSrc: "/media/products/story-editor-hero-dark.mp4",
    posterSrc: "/media/products/story-editor-hero-poster.jpg",
    darkPosterSrc: "/media/products/story-editor-hero-dark-poster.jpg",
    alt: "A Word document being reviewed in the stella Editor",
  },
  agent: {
    videoSrc: "/media/products/story-agent-hero.mp4",
    darkVideoSrc: "/media/products/story-agent-hero-dark.mp4",
    posterSrc: "/media/products/story-agent-hero-poster.jpg",
    darkPosterSrc: "/media/products/story-agent-hero-dark-poster.jpg",
    alt: "A grounded answer with cited matter sources in stella",
  },
  cli: {
    videoSrc: "/media/products/story-cli-hero.mp4",
    darkVideoSrc: "/media/products/story-cli-hero-dark.mp4",
    posterSrc: "/media/products/story-cli-hero-poster.jpg",
    darkPosterSrc: "/media/products/story-cli-hero-dark-poster.jpg",
    alt: "The tools and capability catalogue in stella",
  },
  // Templates has a wide capture only; the hero record reuses it, which
  // object-cover crops slightly in the companion composition.
  templates: {
    videoSrc: "/media/products/story-templates.mp4",
    darkVideoSrc: "/media/products/story-templates-dark.mp4",
    posterSrc: "/media/products/story-templates-poster.jpg",
    darkPosterSrc: "/media/products/story-templates-dark-poster.jpg",
    alt: "A template with fields and conditional clauses in the stella template studio",
  },
  // Product-page section only, wide capture only; the hero record reuses it,
  // which object-cover crops slightly in the companion composition (which
  // never renders this scene in practice — see productStoryScenes/
  // openingProductStory).
  "template-fill": {
    videoSrc: "/media/products/story-template-fill.mp4",
    darkVideoSrc: "/media/products/story-template-fill-dark.mp4",
    posterSrc: "/media/products/story-template-fill-poster.jpg",
    darkPosterSrc: "/media/products/story-template-fill-dark-poster.jpg",
    alt: "Filling a template from a matter's own documents with AI in stella",
  },
} as const satisfies Record<ProductStorySceneId, ProductStoryMedia>;

// Portrait capture (~0.869:1) for the floating "stella Editor" side window in
// the companion composition; recorded at a narrow viewport so the app's
// responsive compact layout fills the window without cropping.
export const productStoryEditorPortraitMedia = {
  videoSrc: "/media/products/story-editor-portrait.mp4",
  darkVideoSrc: "/media/products/story-editor-portrait-dark.mp4",
  posterSrc: "/media/products/story-editor-portrait-poster.jpg",
  darkPosterSrc: "/media/products/story-editor-portrait-dark-poster.jpg",
  alt: "A Word document being reviewed in the stella Editor",
} as const satisfies ProductStoryMedia;

export type StoryDocumentStatus =
  | "active"
  | "complete"
  | "in-review"
  | "needs-review";

export type StoryDocument = {
  id: string;
  name: string;
  status: StoryDocumentStatus;
  statusLabel: string;
  note: string;
  dueDate: string;
  documentType: string;
  playbookResult: string;
};

export const storyDocuments = [
  {
    id: "supplier-agreement",
    name: "Supplier_Agreement.docx",
    status: "needs-review",
    statusLabel: "Needs review",
    note: "Two positions outside playbook",
    dueDate: "18 Jul",
    documentType: "Supplier agreement",
    playbookResult: "2 deviations",
  },
  {
    id: "procurement-playbook",
    name: "Procurement_Playbook.pdf",
    status: "active",
    statusLabel: "Active",
    note: "Approved negotiation positions",
    dueDate: "—",
    documentType: "Playbook",
    playbookResult: "Source",
  },
  {
    id: "board-consent",
    name: "Board_Consent.docx",
    status: "complete",
    statusLabel: "Complete",
    note: "Change-of-control approval recorded",
    dueDate: "16 Jul",
    documentType: "Corporate approval",
    playbookResult: "Aligned",
  },
  {
    id: "due-diligence",
    name: "Due_Diligence_Report.pdf",
    status: "in-review",
    statusLabel: "In review",
    note: "Three source passages linked",
    dueDate: "19 Jul",
    documentType: "Review report",
    playbookResult: "Review",
  },
  {
    id: "risk-summary",
    name: "Risk_Summary.docx",
    status: "in-review",
    statusLabel: "In review",
    note: "Awaiting Legal sign-off",
    dueDate: "20 Jul",
    documentType: "Internal memo",
    playbookResult: "Pending",
  },
] as const satisfies readonly StoryDocument[];

export const storyEditorDocument = {
  fileName: "Supplier_Agreement.docx",
  title: "Supplier Agreement",
  section: "12. Limitation of liability",
  precedingText:
    "Each party remains responsible for its obligations under this Agreement.",
  clause:
    "The Supplier’s aggregate liability shall not exceed 300% of the fees paid under this Agreement.",
  clausePrefix: "The Supplier’s aggregate liability shall not exceed",
  originalCap: "300%",
  replacementCap: "100%",
  clauseSuffix: "of the annual fees paid under this Agreement.",
  followingText:
    "The exclusions in this section survive termination of the Agreement.",
  finding: "Above the approved liability cap",
  recommendation: "Replace 300% with the playbook cap of 100% of annual fees.",
} as const;

export const storyAgentExchange = {
  prompt: "Compare the change-of-control clauses across this matter.",
  tools: [
    { label: "Searched matter documents", meta: "18 documents" },
    { label: "Read relevant clauses", meta: "3 passages" },
    { label: "Checked cited sources", meta: "3 citations" },
  ],
  answer:
    "The supplier agreement and board consent both require approval before a change of control. The SAFE uses a broader liquidity-event trigger.",
  citations: ["Supplier Agreement · §14.2", "Board Consent · §3", "SAFE · §1"],
} as const;

export const storyTeamsExchange = {
  channel: "Supplier agreement",
  context: "Procurement · Contract review",
  role: "Procurement",
  prompt: "Does this agreement follow our procurement playbook?",
  response: "Mostly. Two positions need Legal review.",
  result: "Liability cap · termination notice",
} as const;
