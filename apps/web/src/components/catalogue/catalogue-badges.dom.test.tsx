import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { SkillBindingBadge } = await import("./catalogue-badges");

afterEach(() => cleanup());
afterAll(async () => await unregisterDomEnvironment());

const renderBadge = (binding: "matter" | "client" | null) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <SkillBindingBadge binding={binding} />
    </IntlProvider>,
  );

test("a skill bound to a matter shows the matter badge", () => {
  renderBadge("matter");
  expect(screen.getByText(messages.common.matter)).toBeTruthy();
});

test("a skill bound to a client shows the client badge", () => {
  renderBadge("client");
  expect(screen.getByText(messages.workspaces.parties.client)).toBeTruthy();
});

test("an unbound skill shows no badge", () => {
  const { container } = renderBadge(null);
  expect(container.textContent).toBe("");
});
