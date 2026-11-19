---
"@stll/ui": minor
"@stll/workspace-ui": minor
---

Light modules for loading views drawn before the page mounts. `@stll/ui/truncated-text-face` holds `TruncatedTextFace` and the line classes `TruncatedText` is built from, with no tooltip or popover. `@stll/ui/view-toolbar-shell` holds `ViewChromeBar` and `ViewToolbarChrome`, which `@stll/ui/view-toolbar` re-exports. `@stll/workspace-ui/view-strip` holds the view strip, its tab face and `WorkspaceViewSwitcherFace`, whose tab names are now faces with no hint; `@stll/workspace-ui/view-switcher-face` re-exports them beside `WorkspaceViewTabName`. A strip's `direction` is optional and follows the document when left out.
