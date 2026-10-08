import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "desktop-account",
  capability: "Desktop account link and credential lifecycle",
  owner: ["apps/desktop/src-tauri/src/account.rs"],
  summary:
    "One Keychain record holds account identity and its validated credential. " +
    "Settings and registry search read the same account; expiry, revocation and disconnect " +
    "cannot leave a profile-only connected state. The credential lifetime and prefix " +
    "are derived from the API contract policy shared with the server.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
