import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "desktop-http-client",
  capability: "Identified native desktop HTTP clients",
  owner: ["apps/desktop/src-tauri/src/http_client.rs"],
  summary:
    "DesktopHttpClient is the only constructor for native desktop HTTP. " +
    "It always supplies the desktop User-Agent; Clippy bans raw reqwest Client/ClientBuilder " +
    "types and constructors outside this owner, including aliases and Default paths. " +
    "Local HTTP tests exercise the outgoing headers across configuration choices.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
