import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

// The same order as the other DOM tests here: register, then load the
// libraries that read the document, and unregister when the file is done.
// Queries come from render(), not `screen`: `screen` binds the body of
// whichever file first imported Testing Library in this process.
GlobalRegistrator.register();
const { cleanup, render } = await import("@testing-library/react");
const { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } =
  await import("./accordion");
const { Collapsible, CollapsiblePanel, CollapsibleTrigger } =
  await import("./collapsible");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  cleanup();
  await GlobalRegistrator.unregister();
});

// React renders `hidden` as a boolean, so `until-found` exists only once the
// panel is mounted in a document: these checks read the live element, not
// server markup.
describe("closed disclosure panels stay findable", () => {
  test("a closed Collapsible panel is hidden until found", () => {
    const view = render(
      <Collapsible>
        <CollapsibleTrigger>Show details</CollapsibleTrigger>
        <CollapsiblePanel>Arguments</CollapsiblePanel>
      </Collapsible>,
    );
    const panel = view.container.querySelector(
      '[data-slot="collapsible-panel"]',
    );
    expect(panel?.getAttribute("hidden")).toBe("until-found");
    expect(panel?.textContent).toBe("Arguments");
  });

  test("an open Collapsible panel is not hidden", () => {
    const view = render(
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Hide details</CollapsibleTrigger>
        <CollapsiblePanel>Arguments</CollapsiblePanel>
      </Collapsible>,
    );
    const panel = view.container.querySelector(
      '[data-slot="collapsible-panel"]',
    );
    expect(panel).not.toBeNull();
    expect(panel?.hasAttribute("hidden")).toBe(false);
  });

  test("a closed Accordion panel is hidden until found", () => {
    const view = render(
      <Accordion>
        <AccordionItem value="parties">
          <AccordionTrigger>Parties</AccordionTrigger>
          <AccordionPanel>Claimant and respondent</AccordionPanel>
        </AccordionItem>
      </Accordion>,
    );
    const panel = view.container.querySelector('[data-slot="accordion-panel"]');
    expect(panel?.getAttribute("hidden")).toBe("until-found");
    expect(panel?.textContent).toBe("Claimant and respondent");
  });
});
