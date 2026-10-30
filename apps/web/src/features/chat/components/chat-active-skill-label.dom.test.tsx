import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { TooltipProvider } = await import("@stll/ui/tooltip");
const { default: messages } = await import("@/i18n/langs/en.json");
const { ChatActiveSkillLabel } = await import("./chat-active-skill-label");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const SKILL_NAME = "Review of a long supply agreement under Czech law";

const renderLabel = () =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <TooltipProvider delay={0}>
        <ChatActiveSkillLabel
          skill={{
            skillDisplayName: SKILL_NAME,
            skillId: "skill-1",
            skillName: "supply-agreement-review",
          }}
        />
      </TooltipProvider>
    </IntlProvider>,
  );

/** The label element, sized as the browser would lay it out. */
const labelOf = (
  container: HTMLElement,
  box: { clientWidth: number; scrollWidth: number },
) => {
  const label = container.querySelector('[data-slot="truncated-text"]');
  if (!(label instanceof HTMLElement)) {
    throw new Error("Expected the skill label to render through TruncatedText");
  }
  for (const [property, value] of Object.entries(box)) {
    Object.defineProperty(label, property, { configurable: true, value });
  }
  return label;
};

const hover = async (label: HTMLElement) => {
  await act(async () => {
    fireEvent.pointerEnter(label, { pointerType: "mouse" });
    fireEvent.mouseEnter(label);
    fireEvent.mouseMove(label);
  });
};

const tooltipPopup = () =>
  document.body.querySelector('[data-slot="tooltip-popup"]');

test("a skill name that fits shows no tooltip on hover", async () => {
  const { container } = renderLabel();
  const label = labelOf(container, { clientWidth: 180, scrollWidth: 180 });

  await hover(label);

  expect(label.textContent).toBe(SKILL_NAME);
  expect(tooltipPopup()).toBeNull();
});

test("a skill name cut by its box shows the whole name on hover", async () => {
  const { container } = renderLabel();
  const label = labelOf(container, { clientWidth: 120, scrollWidth: 360 });

  await hover(label);

  await waitFor(() => expect(tooltipPopup()?.textContent).toBe(SKILL_NAME));
  // The full name stays in the label itself for screen readers.
  expect(label.textContent).toBe(SKILL_NAME);
});
