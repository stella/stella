import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "./accordion";

describe("Accordion disclosure", () => {
  test("a closed panel renders its content on the server, plainly hidden", () => {
    const markup = renderToStaticMarkup(
      <Accordion>
        <AccordionItem value="parties">
          <AccordionTrigger>Parties</AccordionTrigger>
          <AccordionPanel>Claimant and respondent</AccordionPanel>
        </AccordionItem>
      </Accordion>,
    );
    expect(markup).toContain('aria-expanded="false"');
    // Base UI renders the closed panel with a plain `hidden` on the server
    // and switches it to `hidden="until-found"` once mounted (see the DOM
    // test), so find-in-page reaches it only after hydration.
    expect(markup).toMatch(/ hidden=""/u);
    expect(markup).not.toMatch(/ hidden="until-found"/u);
    expect(markup).toContain("Claimant and respondent");
  });

  test("a closed panel can stay unmounted instead", () => {
    const markup = renderToStaticMarkup(
      <Accordion hiddenUntilFound={false}>
        <AccordionItem value="parties">
          <AccordionTrigger>Parties</AccordionTrigger>
          <AccordionPanel>Claimant and respondent</AccordionPanel>
        </AccordionItem>
      </Accordion>,
    );
    expect(markup).not.toContain("until-found");
    expect(markup).not.toContain("Claimant and respondent");
  });

  test("the trigger carries trailing status text before its chevron", () => {
    const markup = renderToStaticMarkup(
      <Accordion>
        <AccordionItem value="documents">
          <AccordionTrigger trailing="3 unsaved">Documents</AccordionTrigger>
          <AccordionPanel>List</AccordionPanel>
        </AccordionItem>
      </Accordion>,
    );
    const trailing = markup.indexOf('data-slot="accordion-trigger-trailing"');
    expect(trailing).toBeGreaterThan(markup.indexOf("Documents"));
    expect(markup.indexOf("3 unsaved")).toBeGreaterThan(trailing);
    expect(markup.indexOf('data-slot="accordion-indicator"')).toBeGreaterThan(
      markup.indexOf("3 unsaved"),
    );
  });

  test("the trigger counts a number as status text", () => {
    const markup = renderToStaticMarkup(
      <Accordion>
        <AccordionItem value="documents">
          <AccordionTrigger trailing={3}>Documents</AccordionTrigger>
          <AccordionPanel>List</AccordionPanel>
        </AccordionItem>
      </Accordion>,
    );
    expect(markup).toMatch(
      /data-slot="accordion-trigger-trailing"[^>]*>3<\/span>/u,
    );
  });

  test("a trigger without status text adds no empty slot", () => {
    const markup = renderToStaticMarkup(
      <Accordion>
        <AccordionItem value="documents">
          <AccordionTrigger>Documents</AccordionTrigger>
        </AccordionItem>
      </Accordion>,
    );
    expect(markup).not.toContain("accordion-trigger-trailing");
  });
});

// The trailing slot is text inside the trigger's button, never a control.
const trailingControlContract = () => (
  <Accordion>
    <AccordionItem value="documents">
      {/* @ts-expect-error a control inside the trigger button is unreachable */}
      <AccordionTrigger trailing={<button type="button">Edit</button>}>
        Documents
      </AccordionTrigger>
    </AccordionItem>
  </Accordion>
);
void trailingControlContract;
