import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "desktop-managed-harness",
  capability: "Agent CLIs the desktop installs and runs",
  owner: [
    "apps/desktop/src-tauri/src/harness_installation.rs",
    "apps/desktop/src-tauri/src/harness_release.rs",
    "apps/desktop/src-tauri/src/harness_archive.rs",
    "apps/desktop/src-tauri/harness/pins.json",
    "scripts/generate-harness-releases.ts",
  ],
  summary:
    "pins.json names the Codex and Claude Agent SDK versions; the generator writes the per-platform " +
    "URL, digest, size, target and executable table from upstream metadata, and a Rust test binds the " +
    "table to the pins. HarnessInstallation owns <app data>/harness and <app data>/harness-home: a " +
    "size-capped, digest-checked download, a contained unpack, a --version probe, immutable version " +
    "directories, an atomic active pointer that keeps and rolls back to the previous release, and " +
    "in-process leases that block removal. Executables are started by absolute path, never from PATH.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
