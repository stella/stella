import { hashString } from "./types";

/**
 * The categories an analysis fills, in reading order, with the placeholder
 * line widths an example note draws for each.
 */
export const EXAMPLE_NOTES = [
  { category: "procedural-history", lines: [0.9, 0.55] },
  { category: "facts", lines: [0.85, 0.7, 0.4] },
  { category: "reasoning", lines: [0.95, 0.8, 0.6] },
  { category: "holding", lines: [0.9, 0.65] },
] as const;

type ExampleNoteAnchorsOptions = {
  anchorIds: readonly string[];
  /** The decision id: the same decision draws the same notes on every load. */
  seed: string;
};

/**
 * One paragraph per slice of the decision, a slice for each example note,
 * picked within its slice by the seed. Seeded rather than random so the
 * server and the browser place the notes alike and a reload does not move
 * them. A decision shorter than the notes gets one per paragraph.
 */
export const exampleNoteAnchors = ({
  anchorIds,
  seed,
}: ExampleNoteAnchorsOptions): string[] => {
  const slices = Math.min(EXAMPLE_NOTES.length, anchorIds.length);
  const anchors: string[] = [];
  for (let slice = 0; slice < slices; slice++) {
    const start = Math.floor((anchorIds.length * slice) / slices);
    const end = Math.floor((anchorIds.length * (slice + 1)) / slices);
    const pick =
      start + (hashString(`${seed}:${String(slice)}`) % (end - start));
    const anchor = anchorIds.at(pick);
    if (anchor !== undefined) {
      anchors.push(anchor);
    }
  }
  return anchors;
};
