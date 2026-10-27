import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { createTranslator } from "use-intl/core";

import {
  COLUMN_SORT_KINDS,
  SORT_DIRECTIONS,
} from "@stll/workspace-ui/column-sort";
import { SortChips } from "@stll/workspace-ui/sorts";

import {
  SORT_DIRECTION_LABEL_KEYS,
  sortDirectionLabels,
} from "@/components/workspaces/properties/sort-property.logic";
import { PROPERTY_SORT_KINDS } from "@/components/workspaces/property-utils";
import en from "@/i18n/langs/en.json";

const t = createTranslator({ locale: "en", messages: en });
const labels = sortDirectionLabels((key) => t(key));

test("every kind's labels are the header menu's keys, translated", () => {
  for (const kind of COLUMN_SORT_KINDS) {
    for (const direction of SORT_DIRECTIONS) {
      expect(labels[kind][direction]).toBe(
        t(SORT_DIRECTION_LABEL_KEYS[kind][direction]),
      );
    }
  }
});

// The chip and the header menu name an order from the same record, so a
// property's chip says what its column header's item says.
test.each(
  Object.entries(PROPERTY_SORT_KINDS).flatMap(([type, kind]) =>
    SORT_DIRECTIONS.map((direction) => [type, kind, direction] as const),
  ),
)(
  "a %s property's chip reads the header's %s label sorted %s",
  (type, kind, direction) => {
    const markup = renderToStaticMarkup(
      <SortChips
        labels={{ add: "Add", remove: "Remove", directions: labels }}
        onUpdate={() => undefined}
        properties={[{ id: "p", name: type, type: "text", sortKind: kind }]}
        sorts={[{ propertyId: "p", desc: direction === "desc" }]}
      />,
    );
    expect(markup).toContain(t(SORT_DIRECTION_LABEL_KEYS[kind][direction]));
  },
);
