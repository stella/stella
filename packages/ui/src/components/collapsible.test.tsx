import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Button } from "./button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "./collapsible";

describe("Collapsible", () => {
  test("a closed panel stays findable, as a native details element keeps it", () => {
    const markup = renderToStaticMarkup(
      <Collapsible>
        <CollapsibleTrigger>Show details</CollapsibleTrigger>
        <CollapsiblePanel>Arguments</CollapsiblePanel>
      </Collapsible>,
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('hidden="until-found"');
    expect(markup).toContain("Arguments");
  });

  test("the panel eases its height with the accordion's timing", () => {
    const markup = renderToStaticMarkup(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Hide details</CollapsibleTrigger>
        <CollapsiblePanel>Arguments</CollapsiblePanel>
      </Collapsible>,
    );
    expect(markup).toContain("h-(--collapsible-panel-height)");
    expect(markup).toContain("duration-200 ease-in-out");
    expect(markup).toContain("motion-reduce:transition-none");
  });

  test("an open panel is announced by its trigger", () => {
    const markup = renderToStaticMarkup(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Hide details</CollapsibleTrigger>
        <CollapsiblePanel>Arguments</CollapsiblePanel>
      </Collapsible>,
    );
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).not.toContain('hidden="until-found"');
  });

  test("the trigger takes its look from the button it renders", () => {
    const markup = renderToStaticMarkup(
      <Collapsible>
        <CollapsibleTrigger render={<Button size="sm" variant="muted" />}>
          Show details
        </CollapsibleTrigger>
        <CollapsiblePanel hiddenUntilFound={false}>Arguments</CollapsiblePanel>
      </Collapsible>,
    );
    expect(markup).toContain('data-slot="collapsible-trigger"');
    expect(markup).toContain("text-muted-foreground");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("Arguments");
  });
});
