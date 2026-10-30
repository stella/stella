import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import {
  COLUMN_SORT_KINDS,
  SORT_DIRECTIONS,
  type SortDirectionLabels,
} from "./column-sort";
import { SortChips } from "./sorts";

/** A distinct wording per kind and direction, so a chip can only match its own. */
const DIRECTIONS = {
  text: { asc: "text-asc", desc: "text-desc" },
  date: { asc: "date-asc", desc: "date-desc" },
  number: { asc: "number-asc", desc: "number-desc" },
} as const satisfies SortDirectionLabels;

test.each(
  COLUMN_SORT_KINDS.flatMap((kind) =>
    SORT_DIRECTIONS.map((direction) => [kind, direction] as const),
  ),
)(
  "a %s chip sorted %s reads the caller's wording for that kind and direction",
  (kind, direction) => {
    const markup = renderToStaticMarkup(
      <SortChips
        labels={{ add: "Add", remove: "Remove", directions: DIRECTIONS }}
        onUpdate={() => undefined}
        properties={[
          { id: "p", name: "Property", type: "text", sortKind: kind },
        ]}
        sorts={[{ propertyId: "p", desc: direction === "desc" }]}
      />,
    );

    expect(markup).toContain(DIRECTIONS[kind][direction]);
    for (const other of COLUMN_SORT_KINDS) {
      for (const otherDirection of SORT_DIRECTIONS) {
        if (other !== kind || otherDirection !== direction) {
          expect(markup).not.toContain(DIRECTIONS[other][otherDirection]);
        }
      }
    }
  },
);
