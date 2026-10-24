import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "pdf-rendering",
  capability: "Rendering an uploaded file to a PDF derivative",
  owner: ["apps/api/src/lib/files/gotenberg.ts"],
  summary:
    "One module talks to the conversion service, so the timeout, the " +
    "spreadsheet fit-to-page pre-processing, and the derivative policy that " +
    "decides which MIME types convert stay together.",
  enforcement: {
    kind: "literal-pattern",
    pattern: "forms/libreoffice/convert",
    allowed: [
      {
        path: "apps/api/src/lib/files/converter-settings.ts",
        reason:
          "Pure endpoint construction is shared with the converter's minimal process configuration; network execution stays in gotenberg.ts.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
