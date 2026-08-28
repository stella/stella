import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { CalculationKindPicker, CalculationPicker } from "./calculations";

const labels = {
  choose: "Choose calculation",
  kinds: {
    average: "Average",
    count: "Count",
    "count-empty": "Empty",
    "count-filled": "Filled",
    "count-unique": "Unique",
    max: "Maximum",
    median: "Median",
    min: "Minimum",
    "percent-empty": "Percent empty",
    "percent-filled": "Percent filled",
    "percent-of-total": "Percent of total",
    range: "Range",
    sum: "Sum",
  },
  noProperties: "No calculable properties",
  none: "None",
  unavailable: "Unavailable",
};

describe("calculation pickers", () => {
  test("the property picker is absent when nothing can be calculated", () => {
    const html = renderToStaticMarkup(
      <CalculationPicker
        labels={labels}
        onChange={() => undefined}
        properties={[]}
        selections={[]}
      />,
    );

    expect(html).toBe("");
  });

  test("the kind picker is absent when the property has no reductions", () => {
    const html = renderToStaticMarkup(
      <CalculationKindPicker
        kinds={[]}
        labels={labels}
        onChange={() => undefined}
        value={null}
      />,
    );

    expect(html).toBe("");
  });
});
