import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Button } from "./button";
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from "./collapsible";

describe("Collapsible", () => {
  test("a closed panel renders its content on the server, plainly hidden", () => {
    const markup = renderToStaticMarkup(
      <Collapsible>
        <CollapsibleTrigger>Show details</CollapsibleTrigger>
        <CollapsiblePanel>Arguments</CollapsiblePanel>
      </Collapsible>,
    );
    expect(markup).toContain('aria-expanded="false"');
    // Base UI renders the closed panel with a plain `hidden` on the server
    // and switches it to `hidden="until-found"` once mounted (see the DOM
    // test), so find-in-page reaches it only after hydration.
    expect(markup).toMatch(/ hidden=""/u);
    expect(markup).not.toMatch(/ hidden="until-found"/u);
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
    expect(markup).not.toMatch(/ hidden=/u);
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
