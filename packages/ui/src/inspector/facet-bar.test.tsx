import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { InspectorFacetBar } from "./facet-bar";

type Facet = "alpha" | "beta" | "gamma";

const LABELS: Record<Facet, string> = {
  alpha: "Alpha",
  beta: "Beta",
  gamma: "Gamma",
};

const buttonFor = (markup: string, label: string) => {
  const match = new RegExp(`<button[^>]*>${label}</button>`, "u").exec(markup);
  if (match === null) {
    throw new Error(`no chip button for "${label}" in ${markup}`);
  }
  return match[0];
};

const classesOf = (buttonMarkup: string) =>
  /class="([^"]*)"/u.exec(buttonMarkup)?.[1]?.split(/\s+/u) ?? [];

describe("InspectorFacetBar", () => {
  test("renders every facet's label", () => {
    const markup = renderToStaticMarkup(
      <InspectorFacetBar
        facet="alpha"
        facets={["alpha", "beta", "gamma"]}
        labels={LABELS}
        onChange={() => undefined}
        overflowMenuLabel="Show more"
      />,
    );

    expect(markup).toContain("Alpha");
    expect(markup).toContain("Beta");
    expect(markup).toContain("Gamma");
  });

  test("marks the active facet, and only the active facet", () => {
    const markup = renderToStaticMarkup(
      <InspectorFacetBar
        facet="beta"
        facets={["alpha", "beta", "gamma"]}
        labels={LABELS}
        onChange={() => undefined}
        overflowMenuLabel="Show more"
      />,
    );

    expect(classesOf(buttonFor(markup, "Beta"))).toContain("bg-foreground");
    expect(classesOf(buttonFor(markup, "Alpha"))).not.toContain(
      "bg-foreground",
    );
    expect(classesOf(buttonFor(markup, "Gamma"))).not.toContain(
      "bg-foreground",
    );
  });

  test("honours disabledFacets: only the listed facets are disabled", () => {
    const markup = renderToStaticMarkup(
      <InspectorFacetBar
        disabledFacets={new Set<Facet>(["gamma"])}
        facet="alpha"
        facets={["alpha", "beta", "gamma"]}
        labels={LABELS}
        onChange={() => undefined}
        overflowMenuLabel="Show more"
      />,
    );

    expect(buttonFor(markup, "Gamma")).toContain("disabled");
    expect(buttonFor(markup, "Alpha")).not.toContain("disabled");
    expect(buttonFor(markup, "Beta")).not.toContain("disabled");
  });

  test("shares the toolbar row height", () => {
    const markup = renderToStaticMarkup(
      <InspectorFacetBar
        facet="alpha"
        facets={["alpha", "beta"]}
        labels={LABELS}
        onChange={() => undefined}
        overflowMenuLabel="Show more"
      />,
    );
    const match = /<div[^>]*class="([^"]*)"[^>]*>/u.exec(markup);

    expect(match?.[1]?.split(/\s+/u)).toContain("h-12");
  });
});
