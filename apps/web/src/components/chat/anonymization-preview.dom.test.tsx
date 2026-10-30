import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { useState } = await import("react");
const { act, cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ANIMATED_PREVIEW_CARD_DELAY_MS } =
  await import("@stll/ui/animated-preview");
const messages = (await import("@/i18n/langs/en.json")).default;
const { ChatAnonymizedToggle } =
  await import("@/features/chat/components/chat-anonymized-toggle");
const { AnonymizationPreviewCard } =
  await import("@/components/chat/anonymization-preview");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const OPEN_TIMEOUT_MS = ANIMATED_PREVIEW_CARD_DELAY_MS * 4;

// The shield as the composer dock composes it: the toggle is the card's
// trigger and drops its own on/off tooltip.
const Shield = ({ initiallyEnabled }: { initiallyEnabled: boolean }) => {
  const [enabled, setEnabled] = useState(initiallyEnabled);
  return (
    <AnonymizationPreviewCard
      enabled={enabled}
      trigger={
        <ChatAnonymizedToggle
          enabled={enabled}
          onChange={setEnabled}
          size="icon-xs"
          tooltip={false}
        />
      }
    />
  );
};

const renderShield = (initiallyEnabled: boolean) => {
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <Shield initiallyEnabled={initiallyEnabled} />
    </IntlProvider>,
  );
  const shield = view.getByRole("button", {
    name: messages.chat.anonymizedMode,
  });
  return { shield, view };
};

const card = () =>
  document.querySelector<HTMLElement>('[data-slot="animated-preview-card"]');

const hover = (element: HTMLElement) => {
  fireEvent.pointerEnter(element, { pointerType: "mouse" });
  fireEvent.mouseEnter(element);
  fireEvent.mouseMove(element);
};

const description = (shield: HTMLElement) =>
  document.querySelector(
    `[id="${shield.getAttribute("aria-describedby") ?? ""}"]`,
  )?.textContent;

/** The four stages of the preview's outer, looping frame, in order. */
const outerStages = (root: HTMLElement): HTMLElement[] => {
  const frame = root.querySelector<HTMLElement>(
    '[data-slot="animated-preview"]',
  );
  if (!frame) {
    throw new Error("the preview has no animated frame");
  }
  return [...frame.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child.dataset["slot"] === "animated-preview-stage",
  );
};

const texts = (stage: HTMLElement | undefined, kind: string) => {
  if (!stage) {
    throw new Error("the preview is missing a stage");
  }
  return [
    ...stage.querySelectorAll(`[data-anonymization-preview="${kind}"]`),
  ].map((node) => node.textContent);
};

describe("anonymization shield preview", () => {
  test("hovering the shield opens the preview after the delay", async () => {
    const { shield } = renderShield(true);

    hover(shield);
    expect(card()).toBeNull();

    await waitFor(
      () => {
        expect(card()).not.toBeNull();
      },
      { timeout: OPEN_TIMEOUT_MS },
    );
  });

  test("keyboard focus on the shield opens the preview and keeps focus on the shield", async () => {
    const { shield } = renderShield(false);

    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => {
      shield.focus();
    });

    await waitFor(
      () => {
        expect(card()).not.toBeNull();
      },
      { timeout: OPEN_TIMEOUT_MS },
    );
    expect(document.activeElement).toBe(shield);
  });

  test("the line under the preview says whether anonymization is on, and follows the toggle", async () => {
    const { shield } = renderShield(false);
    const off = messages.chat.anonymizationPreview.off;
    const on = messages.chat.anonymizationPreview.on;

    expect(description(shield)).toBe(off);
    hover(shield);
    await waitFor(
      () => {
        expect(card()?.textContent).toContain(off);
      },
      { timeout: OPEN_TIMEOUT_MS },
    );

    fireEvent.click(shield);

    expect(shield.getAttribute("aria-pressed")).toBe("true");
    expect(description(shield)).toBe(on);
    expect(card()?.textContent).toContain(on);
    expect(card()?.textContent).not.toContain(off);
  });

  test("the stages show the data found, the placeholders sent and answered, and the names restored", async () => {
    const { shield } = renderShield(true);
    hover(shield);
    await waitFor(
      () => {
        expect(card()).not.toBeNull();
      },
      { timeout: OPEN_TIMEOUT_MS },
    );
    const preview = card();
    if (!preview) {
      throw new Error("preview did not open");
    }
    const frame = preview.querySelector<HTMLElement>(
      '[data-slot="animated-preview"]',
    );
    expect(frame?.dataset["playback"]).toBe("loop");

    const [written, sent, answered, restored] = outerStages(preview);
    expect(outerStages(preview)).toHaveLength(4);

    // What you write: the personal data highlighted, no placeholder yet.
    expect(texts(written, "value")).toEqual([
      "Zoë Hartley",
      "QQ 12 34 56 C",
      "14 Elm Row, Leeds",
      "Renée Okafor",
    ]);
    expect(texts(written, "placeholder")).toEqual([]);

    // What the AI receives: each value turns into its placeholder.
    expect(texts(sent, "placeholder")).toEqual([
      "[PERSON_1]",
      "[NATIONAL_ID_1]",
      "[ADDRESS_1]",
      "[PERSON_2]",
    ]);

    // What the AI answers: placeholders only, never the real names.
    expect(texts(answered, "placeholder")).toEqual([
      "[PERSON_1]",
      "[PERSON_2]",
    ]);
    expect(answered?.textContent).not.toContain("Zoë Hartley");

    // What you read: the placeholders turn back into the real names.
    expect(texts(restored, "placeholder")).toEqual([
      "[PERSON_1]",
      "[PERSON_2]",
    ]);
    expect(texts(restored, "restored")).toEqual([
      "Zoë Hartley",
      "Renée Okafor",
    ]);
  });
});
