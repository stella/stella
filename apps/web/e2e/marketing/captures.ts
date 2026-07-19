// Shared capture matrix for the product-story recordings. The recorder
// (record-product-story.ts) derives its capture list from this module and
// stamps each recording into apps/landing/public/media/products/
// recordings-manifest.json; scripts/check-marketing-recordings.ts compares
// that manifest against this module and git history to report stale scenes.
// Keeping the matrix here (dependency-free) lets the root check script import
// it without pulling in Playwright.

export type CaptureViewport = { height: number; width: number };

export type StoryCaptureId = "agent" | "editor" | "review" | "workspace";

export const CAPTURE_THEMES = ["light", "dark"] as const;

export type CaptureTheme = (typeof CAPTURE_THEMES)[number];

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
  sceneId: StoryCaptureId;
  viewport: CaptureViewport;
  watchedPaths: readonly string[];
};

// Repo paths whose changes invalidate every recording: the recorder itself
// (choreography, viewports, trimming), the seed that produces the filmed
// content, and the app chrome visible in every capture.
const COMMON_WATCHED_PATHS = [
  "apps/web/e2e/marketing/captures.ts",
  "apps/web/e2e/marketing/record-product-story.ts",
  "apps/api/scripts/seed-dev.ts",
  "apps/web/src/components/app-sidebar.tsx",
  "apps/web/src/components/app-sidebar.logic.ts",
  "apps/web/src/components/breadcrumbs",
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
  // DOCX editor over the seeded Northstar SAFE ($viewId.document.tsx and
  // -components/docx live inside the workspace slice).
  editor: ["apps/web/src/routes/_protected.workspaces/$workspaceId"],
  // Seeded agent thread in the chat surface.
  agent: [
    "apps/web/src/routes/_protected.chat",
    "apps/web/src/components/chat",
    "apps/web/src/components/ai-elements",
  ],
};

const SCENE_IDS = ["workspace", "review", "editor", "agent"] as const;

const toDefinition = (
  sceneId: StoryCaptureId,
  captureId: string,
  viewport: CaptureViewport,
): CaptureDefinition => ({
  captureId,
  sceneId,
  viewport,
  watchedPaths: [...COMMON_WATCHED_PATHS, ...SCENE_WATCHED_PATHS[sceneId]],
});

// Every scene is captured at the 16:9 wide viewport (scene-only embeds) and
// at the hero viewport (companion composition's main window). The editor is
// additionally captured portrait for the floating side window.
export const captureDefinitions: readonly CaptureDefinition[] =
  SCENE_IDS.flatMap((sceneId) => {
    const definitions = [
      toDefinition(sceneId, sceneId, WIDE_VIEWPORT),
      toDefinition(sceneId, `${sceneId}-hero`, HERO_VIEWPORT),
    ];
    if (sceneId === "editor") {
      definitions.push(
        toDefinition(sceneId, "editor-portrait", PORTRAIT_VIEWPORT),
      );
    }
    return definitions;
  });

export const RECORDINGS_MANIFEST_PATH =
  "apps/landing/public/media/products/recordings-manifest.json";

export type RecordingManifestEntry = {
  captureId: string;
  theme: CaptureTheme;
  viewport: CaptureViewport;
  recordedAtCommit: string;
  watchedPaths: readonly string[];
};

export type RecordingsManifest = {
  entries: readonly RecordingManifestEntry[];
};
