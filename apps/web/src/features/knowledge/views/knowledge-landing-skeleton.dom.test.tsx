import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/knowledge" });

const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { KnowledgeLandingSkeleton } = await import("./knowledge-landing-view");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const skeletonTitles = (audience: "member" | "public") => {
  const { container } = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <KnowledgeLandingSkeleton audience={audience} />
    </IntlProvider>,
  );
  return [...container.querySelectorAll("h2")].map(
    (heading) => heading.textContent,
  );
};

test("a member's skeleton draws every Knowledge section", () => {
  expect(skeletonTitles("member")).toContain(messages.common.workflows);
});

test("a visitor's skeleton leaves out the section no visitor can reach", () => {
  const titles = skeletonTitles("public");
  expect(titles).not.toContain(messages.common.workflows);
  expect(titles).toContain(messages.common.clauses);
});

test("only a visitor's skeleton reserves the account note", () => {
  const notes = (audience: "member" | "public") => {
    const { container, unmount } = render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <KnowledgeLandingSkeleton audience={audience} />
      </IntlProvider>,
    );
    const count = [...container.querySelectorAll("p")].filter(
      (line) => line.textContent === messages.knowledge.landing.withAccount,
    ).length;
    unmount();
    return count;
  };
  expect(notes("public")).toBe(2);
  expect(notes("member")).toBe(0);
});
