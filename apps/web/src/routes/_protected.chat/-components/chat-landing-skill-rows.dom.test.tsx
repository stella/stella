import type { ReactElement } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import messages from "@/i18n/langs/en.json";
import type { SuggestedSkills } from "@/lib/prompts/use-suggested-skills";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ChatLandingSkillRows } =
  await import("@/routes/_protected.chat/-components/chat-landing-skill-rows");

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const NO_SKILLS = messages.chat.landing.noSkills;

const renderRows = (suggestions: SuggestedSkills): ReactElement => (
  <IntlProvider locale="en" messages={messages} timeZone="UTC">
    <ChatLandingSkillRows
      onSelect={() => undefined}
      suggestions={suggestions}
    />
  </IntlProvider>
);

const placeholderRows = (container: HTMLElement) =>
  container.querySelectorAll('[data-slot="landing-row-skeleton"]').length;

test("skills still loading show placeholder rows, never the empty line", () => {
  const { container } = render(renderRows({ type: "pending" }));
  expect(placeholderRows(container)).toBeGreaterThan(0);
  expect(screen.queryByText(NO_SKILLS)).toBeNull();
  expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
});

test("skills that loaded empty show the empty line and no placeholders", () => {
  const { container } = render(
    renderRows({ type: "loaded", feedback: { type: "empty" }, skills: [] }),
  );
  expect(placeholderRows(container)).toBe(0);
  expect(screen.getByText(NO_SKILLS)).toBeDefined();
});

test("loaded skills replace the placeholders with their rows", () => {
  const { container } = render(
    renderRows({
      type: "loaded",
      feedback: { type: "empty" },
      skills: [
        {
          id: "skill-1",
          scope: "team",
          name: "Review the lease",
          command: "review-lease",
          body: "Check the break clause and the rent review.",
          lastEdit: null,
        },
      ],
    }),
  );
  expect(placeholderRows(container)).toBe(0);
  expect(screen.queryByText(NO_SKILLS)).toBeNull();
  expect(screen.getByText("Review the lease")).toBeDefined();
});
