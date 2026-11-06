import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { Window } from "happy-dom";

import { StatuteSignalText } from "@/features/statutes/components/statute-signal-text";

test("a long Signals subject is clamped separately from the act type and number", () => {
  const subject = `ktorým sa mení a dopĺňa zákon ${"o stavebnom sporení ".repeat(40)}`;
  const markup = renderToStaticMarkup(
    <StatuteSignalText
      statute={{
        country: "SVK",
        documentType: "zákon",
        eli: "https://www.slov-lex.sk/eli/sk/zz/2026/274",
        title: subject,
      }}
      meta="In force since 24 Oct 2026"
    />,
  );
  const container = new Window().document.createElement("div");
  // safe-html: React-rendered test markup is parsed only in a detached document.
  container.innerHTML = markup;
  const identity = [...container.querySelectorAll("span")].find(
    (element) => element.textContent === "Zákon č. 274/2026 Z. z.",
  );
  expect(identity).toBeDefined();
  expect(identity?.className).not.toMatch(
    /truncate|line-clamp|overflow-hidden/u,
  );
  for (
    let element = identity?.parentElement ?? null;
    element !== null;
    element = element.parentElement
  ) {
    expect(element.className).not.toMatch(
      /truncate|line-clamp|overflow-hidden/u,
    );
  }
  const clamped = container.querySelector(".line-clamp-2");
  expect(clamped?.textContent).toBe(subject.trim());
  expect(container.textContent).toContain("In force since 24 Oct 2026");
});
