import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "clipboard-write",
  capability: "Writing text to the system clipboard in the browser",
  owner: ["packages/clipboard/"],
  summary:
    "`navigator.clipboard.writeText` rejects on a denied permission or an " +
    "insecure context, and every call site owes the user that outcome. " +
    "`@stll/clipboard` wraps it in a `Result`, so callers branch on the " +
    "failure instead of each growing its own try/catch: `apps/web` toasts " +
    "and captures it, the `apps/landing` inline scripts leave the copy " +
    "button idle. oxlint does not scan `.astro`, so the landing side is " +
    "held by the `landing-inline-clipboard-writes` ratchet metric instead " +
    "of this rule.",
  enforcement: {
    kind: "global-member",
    object: "navigator",
    path: ["clipboard", "writeText"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
