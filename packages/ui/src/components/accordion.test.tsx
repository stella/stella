import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "./accordion";

const triggerClass = (markup: string) => {
  const tag =
    /<[a-z]+\b[^>]*data-slot="accordion-trigger"[^>]*>/u.exec(markup)?.[0] ??
    "";
  return /class="([^"]*)"/u.exec(tag)?.[1] ?? "";
};

describe("Accordion sizes and trigger variants", () => {
  test("a default trigger reads as a heading", () => {
    const markup = renderToStaticMarkup(
      <Accordion>
        <AccordionItem>
          <AccordionTrigger>Details</AccordionTrigger>
        </AccordionItem>
      </Accordion>,
    );

    expect(triggerClass(markup)).toContain("font-medium");
    expect(triggerClass(markup)).toContain("py-4");
  });

  test("a muted sm trigger is a quiet 44px line in body type", () => {
    const markup = renderToStaticMarkup(
      <Accordion>
        <AccordionItem>
          <AccordionTrigger size="sm" variant="muted">
            Show all permissions
          </AccordionTrigger>
          <AccordionPanel keepMounted size="sm">
            Read your documents
          </AccordionPanel>
        </AccordionItem>
      </Accordion>,
    );
    const trigger = triggerClass(markup);

    expect(trigger).toContain("min-h-11");
    expect(trigger).toContain("text-sm");
    expect(trigger).toContain("text-muted-foreground");
    expect(trigger).toContain("font-normal");
    expect(trigger).not.toContain("font-medium");
    expect(trigger).not.toContain("py-4");
    expect(markup).toContain("pb-2");
    expect(markup).not.toContain("pb-4");
  });
});
