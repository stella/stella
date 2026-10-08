import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "pdf-rendering",
  capability: "Rendering an uploaded file to a PDF derivative",
  owner: ["apps/api/src/lib/files/gotenberg.ts"],
  summary:
    "One module talks to the conversion service, so the timeout, the " +
    "spreadsheet fit-to-page pre-processing, and the derivative policy that " +
    "decides which MIME types convert stay together.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
