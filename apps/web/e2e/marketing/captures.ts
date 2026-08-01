// Shared capture matrix for the product-story recordings. The recorder
// (record-product-story.ts) derives its capture list from this module and
// stamps each recording into apps/landing/public/media/products/
// recordings-manifest.json; scripts/check-marketing-recordings.ts compares
// that manifest against this module and git history to report stale scenes.
// Keeping the matrix here (dependency-free) lets the root check script import
// it without pulling in Playwright.

export type CaptureViewport = { height: number; width: number };

// "editor-doc" is the portrait-only scene: the same seeded Supplier
// Agreement opened in the document full view with the app sidebar collapsed,
// so the floating editor side window shows the docx page rather than the
// whole app squeezed narrow.
// "templates" films the seeded Supply Agreement template open in the
// template studio (fields and conditional sections highlighted).
// "cli" films the Knowledge tools catalogue: the real MCP/capability surface
// the CLI and MCP expose, recorded as its own scene instead of reusing the
// agent chat footage.
// "review-citation" films the cell-to-passage click-through in the same
// Table view as "review": hovering a citation-bearing cell and clicking
// through opens the source document at its exact-passage highlight.
// Product-page-only (apps/landing/src/data/products/tabular-review.ts), so
// unlike the other scenes it has no "-hero" companion variant.
// "template-fill" films the seeded Supply Agreement's "Prefill from
// documents" flow inside the Meridian workspace: expanding the panel,
// picking the matter's own Supplier_Agreement.docx, and the AI-drafted
// field values actually appearing. Product-page-only, like "review-citation".
export type StoryCaptureId =
  | "agent"
  | "cli"
  | "editor"
  | "editor-doc"
  | "review"
  | "review-citation"
  | "template-fill"
  | "templates"
  | "workspace";

export const CAPTURE_THEMES = ["light", "dark"] as const;

export type CaptureTheme = (typeof CAPTURE_THEMES)[number];

// All captures record at 2x device pixels: the landing page renders them in
// CSS-sized boxes on mostly-retina screens, and 1x captures upscale soft.
// The staleness checker treats a DPR change like a viewport change.
export const CAPTURE_DPR = 2;

// 16:9 masters for the scene-only embeds (product pages, HomeProductStory
// chapters), whose main-window content box sits near 16:9.
export const WIDE_VIEWPORT = { height: 720, width: 1280 } as const;

// The homepage hero's companion composition (aspect 2.03 scene, main window
// w-67% h-86% minus the vw-based titlebar) leaves a main content box of
// 0.67 / (0.86 / 2.03 - 0.0235) ≈ 1.674:1. 1280x764 = 1.675.
export const HERO_VIEWPORT = { height: 764, width: 1280 } as const;

// The floating "stella Editor" side window (w-18.5% h-48% minus titlebar in
// the same 2.03 scene) is portrait: 0.185 / (0.48 / 2.03 - 0.0235) ≈ 0.869:1.
// 900x1036 = 0.869; the app's responsive compact layout is the point.
export const PORTRAIT_VIEWPORT = { height: 1036, width: 900 } as const;

export type CaptureDefinition = {
  captureId: string;
  dpr: number;
  sceneId: StoryCaptureId;
  viewport: CaptureViewport;
  watchedPaths: readonly string[];
};

// Repo paths whose changes invalidate every recording: the recorder itself
// (choreography, viewports, trimming), the seed that produces the filmed
// content, the app chrome visible in every capture, and the global rendering
// inputs every filmed route resolves through. Without those last three, a
// site-wide typography or design-token change would repaint every scene while
// the staleness gate still reported all recordings fresh.
const COMMON_WATCHED_PATHS = [
  "apps/web/e2e/marketing/captures.ts",
  "apps/web/e2e/marketing/record-product-story.ts",
  "apps/api/scripts/seed-dev.ts",
  // Owns the filmed organization and primary-user display names, which the
  // sidebar chrome and every authored-by surface render.
  "apps/api/scripts/seed-test-user.ts",
  "apps/web/src/components/app-sidebar.tsx",
  "apps/web/src/components/app-sidebar.logic.ts",
  "apps/web/src/components/breadcrumbs",
  "apps/web/src/routes/__root.tsx",
  "apps/web/src/fonts.css",
  "packages/ui/src/styles/globals.css",
] as const;

// Per-scene product surfaces, deliberately whole feature slices
// (broader-but-true) rather than individual files. Not tracked: rendering
// changes that arrive through dependency upgrades (notably @stll/folio-react
// for the editor scene) — judge those manually when bumping.
const SCENE_WATCHED_PATHS: Record<StoryCaptureId, readonly string[]> = {
  // Files view of the seeded Export Review workspace.
  workspace: ["apps/web/src/routes/_protected.workspaces/$workspaceId"],
  // Table view of the same workspace.
  review: ["apps/web/src/routes/_protected.workspaces/$workspaceId"],
  // Same Table view, clicking a citation-bearing cell through to its source
  // passage: reaches the global inspector (outside the workspace route
  // slice) and folio's docx exact-passage-highlight wiring, neither of
  // which the plain "review" scene exercises.
  "review-citation": [
    "apps/web/src/routes/_protected.workspaces/$workspaceId",
    "apps/web/src/components/inspector",
    "apps/web/src/routes/_protected.tsx",
  ],
  // DOCX editor over the seeded Supplier Agreement redline
  // ($viewId.document.tsx and -components/docx live inside the workspace
  // slice).
  editor: ["apps/web/src/routes/_protected.workspaces/$workspaceId"],
  // Document full view of the same Supplier Agreement, sidebar collapsed.
  "editor-doc": ["apps/web/src/routes/_protected.workspaces/$workspaceId"],
  // Seeded agent thread in the chat surface.
  agent: [
    "apps/web/src/routes/_protected.chat",
    "apps/web/src/components/chat",
    "apps/web/src/components/ai-elements",
  ],
  // Seeded Supply Agreement template in the Knowledge template studio; the
  // filmed content comes from seed-templates.ts, not seed-dev.ts.
  templates: [
    "apps/web/src/routes/_protected.knowledge",
    "apps/api/scripts/seed-templates.ts",
  ],
  // Knowledge tools catalogue (the MCP/capability surface).
  cli: ["apps/web/src/routes/_protected.knowledge"],
  // "New document from template" inside the Meridian workspace (workspace
  // slice) plus the Prefill-from-documents panel (knowledge slice, same
  // TemplateForm/TemplatePrefillPanel the Template Studio Fill tab uses).
  // Mirrors both "templates"' and "review"/"workspace"'s watched roots, plus
  // the dev-only mock fixture the seeded fill values are frozen from — that
  // fixture, not a live model, is what this scene actually films.
  "template-fill": [
    "apps/web/src/routes/_protected.workspaces/$workspaceId",
    "apps/web/src/routes/_protected.knowledge",
    "apps/api/scripts/seed-templates.ts",
    "apps/api/src/dev/register-mock-ai.ts",
  ],
};

// Scenes consumed at both the wide (scene-only embeds) and hero (companion
// composition main window) viewports. "templates" is wide-only below: it
// plays only in scene-only embeds (templates product page).
const SCENE_IDS = ["workspace", "review", "editor", "agent", "cli"] as const;

const toDefinition = (
  sceneId: StoryCaptureId,
  captureId: string,
  viewport: CaptureViewport,
): CaptureDefinition => ({
  captureId,
  dpr: CAPTURE_DPR,
  sceneId,
  viewport,
  watchedPaths: [...COMMON_WATCHED_PATHS, ...SCENE_WATCHED_PATHS[sceneId]],
});

// Every scene is captured at the 16:9 wide viewport (scene-only embeds) and
// at the hero viewport (companion composition's main window). The floating
// editor side window additionally gets the portrait-only document scene.
export const captureDefinitions: readonly CaptureDefinition[] = [
  ...SCENE_IDS.flatMap((sceneId) => [
    toDefinition(sceneId, sceneId, WIDE_VIEWPORT),
    toDefinition(sceneId, `${sceneId}-hero`, HERO_VIEWPORT),
  ]),
  toDefinition("templates", "templates", WIDE_VIEWPORT),
  toDefinition("editor-doc", "editor-portrait", PORTRAIT_VIEWPORT),
  // Product-page section only (tabular-review.ts section 2): no hero/
  // companion variant.
  toDefinition("review-citation", "review-citation", WIDE_VIEWPORT),
  // Product-page section only (templates.ts section 2): no hero/companion
  // variant.
  toDefinition("template-fill", "template-fill", WIDE_VIEWPORT),
];

export const RECORDINGS_MANIFEST_PATH =
  "apps/landing/public/media/products/recordings-manifest.json";

export type RecordingManifestEntry = {
  captureId: string;
  theme: CaptureTheme;
  viewport: CaptureViewport;
  dpr: number;
  recordedAtCommit: string;
  watchedPaths: readonly string[];
};

export type RecordingsManifest = {
  entries: readonly RecordingManifestEntry[];
};
