import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { DECISION_CITATION_PRESENTATION } from "@/components/references/decision-citation-presentation.logic";
import type { DecisionCitationPresentation } from "@/components/references/decision-citation-presentation.logic";
import { env } from "@/env";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { DecisionCitationChip } = await import("./decision-citation-chip");
const messages = (await import("@/i18n/langs/en.json")).default;

const decision = {
  decisionId: "00000000-0000-4000-8000-000000000001",
  court: "Synthetic Supreme Court",
  courtShortCode: "SYN",
  caseNumber: "SYN 12/2026",
  decisionDate: "2026-01-12",
  readerUrl: "/law/cze/cases/synthetic-supreme-court/synthetic-decision",
  originalUrl: "https://publisher.example.test/synthetic-decision",
};
const sentence = "The remedy remains available.";
const passage = "The publisher's complete supporting passage.";
const ACTIVATION = { focus: "focus", hover: "hover" } as const;
const reference = "Synthetic Supreme Court, SYN 12/2026, Jan 12, 2026";

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const mount = (
  presentation: DecisionCitationPresentation = DECISION_CITATION_PRESENTATION.compact,
  originalUrl: string | null = decision.originalUrl,
) =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <p>
          {sentence}{" "}
          <DecisionCitationChip
            decision={{ ...decision, originalUrl }}
            passage={passage}
            presentation={presentation}
          />
        </p>
      </FormattingProvider>
    </IntlProvider>,
  );

for (const presentation of Object.values(DECISION_CITATION_PRESENTATION)) {
  test(`${presentation} citation follows the sentence and keeps the passage outside its accessible trigger`, () => {
    const view = mount(presentation);
    const trigger = view.getByRole("button", { name: reference });
    const paragraph = trigger.closest("p");
    expect(paragraph?.firstChild?.textContent).toBe(sentence);
    expect(trigger.getAttribute("href")).toBe(
      new URL(decision.readerUrl, env.VITE_PUBLIC_APP_URL).href,
    );
    expect(trigger.dataset["citationPresentation"]).toBe(presentation);
    expect(trigger.textContent).toBe(
      presentation === DECISION_CITATION_PRESENTATION.compact
        ? "SYN"
        : "SYNSYN 12/2026",
    );
    expect(trigger.textContent).not.toContain(passage);
    expect(trigger.getAttribute("aria-label")).toBe(reference);
    expect(view.queryByText(passage)).toBeNull();
  });
}

for (const activation of Object.values(ACTIVATION)) {
  test(`${activation} exposes court, case, date, passage and both decision actions`, async () => {
    const view = mount();
    const trigger = view.getByRole("button", { name: reference });
    if (activation === ACTIVATION.focus) {
      fireEvent.focus(trigger);
    } else {
      fireEvent.pointerOver(trigger, { pointerType: "mouse" });
      fireEvent.mouseEnter(trigger);
      fireEvent.mouseMove(trigger);
    }
    await waitFor(() => {
      expect(screen.getByText(decision.court)).toBeTruthy();
      expect(screen.getByText(decision.caseNumber)).toBeTruthy();
      expect(screen.getByText("Jan 12, 2026")).toBeTruthy();
      expect(screen.getByText(passage)).toBeTruthy();
      expect(
        screen
          .getByRole("link", { name: messages.caseLaw.citation.openInStella })
          .getAttribute("href"),
      ).toBe(new URL(decision.readerUrl, env.VITE_PUBLIC_APP_URL).href);
      const original = screen.getByRole("link", {
        name: messages.inspector.external.openOriginal,
      });
      expect(original.getAttribute("href")).toBe(decision.originalUrl);
      expect(original.getAttribute("target")).toBe("_blank");
      expect(original.getAttribute("rel")).toBe("noopener noreferrer");
    });
    expect(trigger.textContent).toBe("SYN");
    expect(view.container.querySelector("a a, a button")).toBeNull();
  });
}

test("Escape restores focus without reopening, and a later focus opens again", async () => {
  const view = mount();
  const trigger = view.getByRole("button", { name: reference });
  await act(async () => {
    trigger.focus();
  });
  const reader = await screen.findByRole("link", {
    name: messages.caseLaw.citation.openInStella,
  });
  await act(async () => {
    reader.focus();
    fireEvent.keyDown(reader, { key: "Escape" });
  });
  await waitFor(() => {
    expect(screen.queryByText(passage)).toBeNull();
    expect(view.container.ownerDocument.activeElement).toBe(trigger);
  });
  await act(async () => {
    trigger.blur();
    trigger.focus();
  });
  expect(await screen.findByText(passage)).toBeTruthy();
});

test("an unavailable original remains a disabled action alongside the reader action", async () => {
  const view = mount(DECISION_CITATION_PRESENTATION.compact, null);
  fireEvent.focus(view.getByRole("button", { name: reference }));
  await waitFor(() => {
    expect(
      screen
        .getByRole("button", { name: messages.inspector.external.openOriginal })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("link", { name: messages.caseLaw.citation.openInStella })
        .getAttribute("href"),
    ).toBe(new URL(decision.readerUrl, env.VITE_PUBLIC_APP_URL).href);
  });
});

for (const protocol of ["javascript", "data"]) {
  const originalUrl = `${protocol}:unsafe`;
  test(`an unsafe publisher protocol ${originalUrl} cannot become a citation action`, async () => {
    const view = mount(DECISION_CITATION_PRESENTATION.compact, originalUrl);
    fireEvent.focus(view.getByRole("button", { name: reference }));
    await waitFor(() => {
      expect(
        screen.queryByRole("link", {
          name: messages.inspector.external.openOriginal,
        }),
      ).toBeNull();
      expect(
        screen
          .getByRole("button", {
            name: messages.inspector.external.openOriginal,
          })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        screen
          .getByRole("link", { name: messages.caseLaw.citation.openInStella })
          .getAttribute("href"),
      ).toBe(new URL(decision.readerUrl, env.VITE_PUBLIC_APP_URL).href);
    });
    expect(
      view.container.querySelector('a[href^="javascript:"], a[href^="data:"]'),
    ).toBeNull();
  });
}
