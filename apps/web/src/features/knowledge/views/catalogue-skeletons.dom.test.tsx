import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({
  url: "http://localhost:3000/knowledge/templates",
});

const { renderToString } = await import("react-dom/server");
const { hydrateRoot } = await import("react-dom/client");
const { act, cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { TemplateListSkeleton } = await import("./templates/template-list-view");
const { KnowledgeLandingSkeleton } = await import("./knowledge-landing-view");
const { deviceStorage } = await import("@/lib/account/browser-storage");

const densityStorage = deviceStorage("local");
afterEach(() => {
  cleanup();
  densityStorage.removeItem("stella.templates.density");
});
afterAll(unregisterDomEnvironment);

const templateTree = () => (
  <IntlProvider locale="en" messages={messages} timeZone="UTC">
    <TemplateListSkeleton />
  </IntlProvider>
);

test("saved comfortable density preserves the server rows during hydration", async () => {
  const html = renderToString(templateTree());
  densityStorage.setItem("stella.templates.density", "comfortable");
  expect(renderToString(templateTree())).toBe(html);
  const container = document.createElement("div");
  // safe-html: React serializes this local skeleton fixture without external content.
  container.innerHTML = html;
  document.body.append(container);
  const serverRow = container.querySelector("li");
  expect(serverRow).not.toBeNull();
  const errors: unknown[] = [];
  const root = await act(async () =>
    hydrateRoot(container, templateTree(), {
      onRecoverableError: (error) => {
        errors.push(error);
      },
    }),
  );
  try {
    expect(errors).toEqual([]);
    expect(container.querySelector("li")).toBe(serverRow);
    expect(serverRow?.isConnected).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test.each([
  { audience: "public", noteCount: 2 },
  { audience: "member", noteCount: 0 },
] as const)(
  "$audience loading cards reserve $noteCount account notes",
  ({ audience, noteCount }) => {
    const view = render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <KnowledgeLandingSkeleton audience={audience} />
      </IntlProvider>,
    );
    expect(
      view.queryAllByText(messages.knowledge.landing.withAccount),
    ).toHaveLength(noteCount);
  },
);

test("the public template skeleton does not reserve absent mobile filters", () => {
  const view = render(templateTree());
  expect(view.container.querySelector(".md\\:hidden") === null).toBe(true);
});
