import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "text-mark",
  capability:
    "Marking words in running text: search and find hits, reader highlights, verdict underlines",
  owner: ["packages/ui/src/review/text-mark.tsx"],
  summary:
    "One inline mark with a fill or a line, a tone and an active state, so a " +
    "found word, a note and a finding differ only in hue and line. Render " +
    "`TextMark`, or take `textMarkClass` for markup that is not a `<mark>`; " +
    "search hits use `SEARCH_HIT_MARK`. The `no-ad-hoc-text-mark` lint rule " +
    "rejects a hand-styled `<mark>`.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
