import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { DECISION_CITATION_PRESENTATION } from "@/components/references/decision-citation-presentation.logic";
import type { DecisionCitationPresentation } from "@/components/references/decision-citation-presentation.logic";
import { env } from "@/env";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://self-hosted.example.test/chat" });
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { DecisionCitationChip } = await import("./decision-citation-chip");
const messages = (await import("@/i18n/langs/en.json")).default;
const germanMessages = (await import("@/i18n/langs/de.json")).default;

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
  await unregisterDomEnvironment();
});

const mount = (
  presentation: DecisionCitationPresentation = DECISION_CITATION_PRESENTATION.compact,
  originalUrl: string | null = decision.originalUrl,
  paragraphNumber: number | null = null,
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
            paragraphNumber={paragraphNumber}
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
    expect(trigger.getAttribute("href")).toBe(decision.readerUrl);
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

for (const presentation of Object.values(DECISION_CITATION_PRESENTATION)) {
  test(`${presentation} citation names the court's paragraph number visibly and in its accessible name`, () => {
    const view = mount(presentation, decision.originalUrl, 8);
    const trigger = view.getByRole("button", {
      name: `${reference}, paragraph 8`,
    });
    expect(trigger.dataset["citationPresentation"]).toBe(presentation);
    expect(trigger.textContent).toBe(
      presentation === DECISION_CITATION_PRESENTATION.compact
        ? "SYN\u00b6\u00a08"
        : "SYNSYN 12/2026\u00b6\u00a08",
    );
    expect(view.queryByRole("button", { name: reference })).toBeNull();
  });
}

test("the popover names the cited paragraph beside the case, and names none when the court printed none", async () => {
  const numbered = mount(DECISION_CITATION_PRESENTATION.compact, null, 8);
  fireEvent.focus(
    numbered.getByRole("button", { name: `${reference}, paragraph 8` }),
  );
  expect(await screen.findByText("Paragraph 8")).toBeTruthy();
  expect(screen.getByText(decision.caseNumber)).toBeTruthy();
  numbered.unmount();

  const unnumbered = mount(DECISION_CITATION_PRESENTATION.compact, null);
  fireEvent.focus(unnumbered.getByRole("button", { name: reference }));
  expect(await screen.findByText(decision.caseNumber)).toBeTruthy();
  expect(screen.queryByText(/^Paragraph/u)).toBeNull();
});

test("the paragraph number follows the reader's locale", () => {
  const view = render(
    <IntlProvider locale="de" messages={germanMessages} timeZone="UTC">
      <FormattingProvider locale="de" timeZone="UTC">
        <DecisionCitationChip decision={decision} paragraphNumber={1234} />
      </FormattingProvider>
    </IntlProvider>,
  );
  const trigger = view.getByRole("button");
  expect(trigger.textContent).toBe("SYN\u00b6\u00a01.234");
  expect(trigger.getAttribute("aria-label")).toEndWith(", Randnummer 1.234");
});

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
          .getByRole("link", { name: messages.common.openInStella })
          .getAttribute("href"),
      ).toBe(decision.readerUrl);
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
    name: messages.common.openInStella,
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
        .getByRole("link", { name: messages.common.openInStella })
        .getAttribute("href"),
    ).toBe(decision.readerUrl);
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
          .getByRole("link", { name: messages.common.openInStella })
          .getAttribute("href"),
      ).toBe(decision.readerUrl);
    });
    expect(
      view.container.querySelector('a[href^="javascript:"], a[href^="data:"]'),
    ).toBeNull();
  });
}

for (const readerUrl of [
  `${decision.readerUrl}?q=remedy#p-28`,
  new URL(`${decision.readerUrl}?q=remedy#p-28`, env.VITE_PUBLIC_APP_URL).href,
  new URL(
    `${decision.readerUrl}?q=remedy#p-28`,
    "http://self-hosted.example.test",
  ).href,
]) {
  test(`served reader URL ${readerUrl} stays on this deployment and primary clicks use the in-app opener`, async () => {
    const opened: string[] = [];
    const view = render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <DecisionCitationChip
            decision={{ ...decision, readerUrl }}
            onOpen={() => {
              opened.push(decision.decisionId);
            }}
          />
        </FormattingProvider>
      </IntlProvider>,
    );
    const trigger = view.getByRole("button", { name: reference });
    expect(trigger.getAttribute("href")).toBe(
      `${decision.readerUrl}?q=remedy#p-28`,
    );
    fireEvent.focus(trigger);
    const action = await screen.findByRole("link", {
      name: messages.common.openInStella,
    });
    expect(action.getAttribute("href")).toBe(
      `${decision.readerUrl}?q=remedy#p-28`,
    );
    expect(
      new URL(action.getAttribute("href") ?? "", window.location.href).origin,
    ).toBe(window.location.origin);
    expect(fireEvent.click(action, { ctrlKey: true })).toBe(true);
    expect(opened).toEqual([]);
    expect(fireEvent.click(action)).toBe(false);
    expect(opened).toEqual([decision.decisionId]);
  });
}

test("a pointer press keeps the citation preview open after focus has opened it", async () => {
  const view = mount();
  const trigger = view.getByRole("button", { name: reference });
  fireEvent.focus(trigger);
  await waitFor(() =>
    expect(trigger.getAttribute("aria-expanded")).toBe("true"),
  );
  fireEvent.click(trigger);
  await waitFor(() =>
    expect(trigger.getAttribute("aria-expanded")).toBe("true"),
  );
  expect(
    screen.getByRole("link", { name: messages.common.openInStella }),
  ).toBeTruthy();
});
