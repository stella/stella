import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "./accordion";

describe("Accordion disclosure", () => {
  test("a closed panel stays findable by find-in-page", () => {
    const markup = renderToStaticMarkup(
      <Accordion>
        <AccordionItem value="parties">
          <AccordionTrigger>Parties</AccordionTrigger>
          <AccordionPanel>Claimant and respondent</AccordionPanel>
        </AccordionItem>
      </Accordion>,
    );
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('hidden="until-found"');
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
