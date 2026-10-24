import type { ReactNode } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { AI_DISCLOSURES } from "@stll/api-contract/ai-disclosure";
import type { DecisionAnalysis } from "@stll/legal-ast/analysis";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { HeadnoteBlock } = await import("@stll/decision-reader/headnote-block");
const { WebReaderPresentationProvider } =
  await import("@/components/legal-reader/web-reader-presentation");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { messageLoaders } = await import("@/i18n/i18n-store");
const { AnalysisLayers } =
  await import("@/features/case-law/components/case-viewer/analysis/analysis-layers");
const { ReaderAiLabel } = await import("@stll/decision-reader/reader-ai-label");

afterEach(() => {
  cleanup();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

const disclosure = messages.aiDisclosure.caseLaw;
const MODEL_HOLDING = "Model holding sentence.";
const COURT_ABSTRACT = "Court abstract.";

const Providers = ({
  children,
  catalogue = messages,
  locale = "en",
}: {
  children: ReactNode;
  catalogue?: typeof messages;
  locale?: string;
}) => (
  <IntlProvider locale={locale} messages={catalogue} timeZone="UTC">
    <FormattingProvider locale={locale} timeZone="UTC">
      <WebReaderPresentationProvider>{children}</WebReaderPresentationProvider>
    </FormattingProvider>
  </IntlProvider>
);

/** The disclosure is in the document only while its popover is open. */
const disclosureShown = () => screen.queryByText(disclosure) !== null;

describe("ReaderAiLabel", () => {
  test("is a button named by its visible words, closed until asked", () => {
    render(
      <Providers>
        <ReaderAiLabel
          context="caseLaw"
          label={messages.caseLaw.notesFilter.ai}
        />
      </Providers>,
    );

    const trigger = screen.getByRole("button", {
      name: messages.caseLaw.notesFilter.ai,
    });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("type")).toBe("button");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    // The sparkle is decoration; the words carry the meaning.
    expect(trigger.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(disclosureShown()).toBe(false);
  });

  test("a click opens the disclosure in a named dialog, Escape closes it", async () => {
    render(
      <Providers>
        <ReaderAiLabel
          context="caseLaw"
          label={messages.caseLaw.notesFilter.ai}
        />
      </Providers>,
    );
    const trigger = screen.getByRole("button", {
      name: messages.caseLaw.notesFilter.ai,
    });

    await act(async () => {
      fireEvent.click(trigger);
    });

    const dialog = await screen.findByRole("dialog", {
      name: messages.caseLaw.notesFilter.ai,
    });
    expect(within(dialog).getByText(disclosure)).toBeDefined();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // Read out with the dialog, not only shown in it.
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(
      document.querySelector(`[id="${describedBy ?? ""}"]`)?.textContent,
    ).toBe(disclosure);

    await act(async () => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
  });

  test("the keyboard reaches it and opens it without a pointer", async () => {
    render(
      <Providers>
        <ReaderAiLabel
          context="caseLaw"
          label={messages.caseLaw.notesFilter.ai}
        />
      </Providers>,
    );
    const trigger = screen.getByRole("button", {
      name: messages.caseLaw.notesFilter.ai,
    });

    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.tabIndex).toBe(0);

    // A native button turns Enter and Space into a click; the popover opens
    // on that click, never on hover.
    await act(async () => {
      fireEvent.mouseEnter(trigger);
      fireEvent.pointerEnter(trigger);
    });
    expect(disclosureShown()).toBe(false);

    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
      fireEvent.click(trigger, { detail: 0 });
    });
    expect(await screen.findByText(disclosure)).toBeDefined();
  });

  test("every locale says it in its own words", async () => {
    for (const [locale, load] of Object.entries(messageLoaders)) {
      const catalogue = await load();
      const sentence = catalogue.aiDisclosure.caseLaw;

      expect(sentence.trim().length).toBeGreaterThan(0);
      // The brand stays lowercase in every language.
      expect(sentence).toContain("stella");
      expect(sentence).not.toContain("Stella");
      if (locale !== "en") {
        expect(sentence).not.toBe(disclosure);
      }

      render(
        <Providers catalogue={catalogue} locale={locale}>
          <ReaderAiLabel
            context="caseLaw"
            label={catalogue.caseLaw.notesFilter.ai}
          />
        </Providers>,
      );
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: catalogue.caseLaw.notesFilter.ai,
          }),
        );
      });
      expect(await screen.findByText(sentence)).toBeDefined();
      cleanup();
    }
  });

  test("the English catalogue says exactly what agents are told", () => {
    expect(messages.aiDisclosure.caseLaw).toBe(AI_DISCLOSURES.caseLaw.text);
  });
});

describe("the AI mark at each place the reader marks generated text", () => {
  test("a model's headnote carries the mark, the court's does not", async () => {
    render(
      <Providers>
        <HeadnoteBlock
          defaultOpen={false}
          label={messages.caseLaw.viewer.legalSentence}
          origin={{ type: "ai" }}
        >
          {MODEL_HOLDING}
        </HeadnoteBlock>
        <HeadnoteBlock
          defaultOpen={false}
          label={messages.caseLaw.viewer.abstract}
          origin={{ type: "court", chip: null }}
        >
          {COURT_ABSTRACT}
        </HeadnoteBlock>
      </Providers>,
    );

    const marks = screen.getAllByRole("button", {
      name: messages.caseLaw.notesFilter.ai,
    });
    expect(marks).toHaveLength(1);
    const [mark] = marks;
    // On the section's row, never inside its toggle: a control within a
    // `<summary>` is nested interactive content.
    expect(mark?.closest("summary")).toBeNull();
    const details = mark
      ?.closest('[data-slot="headnote-block"]')
      ?.querySelector("details");
    expect(details?.textContent).toContain(MODEL_HOLDING);
    // Announced before the text it describes, not after the whole section.
    expect(
      mark !== undefined &&
        details?.previousElementSibling?.contains(mark) === true,
    ).toBe(true);

    await act(async () => {
      if (mark !== undefined) {
        fireEvent.click(mark);
      }
    });
    expect(await screen.findByText(disclosure)).toBeDefined();
    // Asking what the mark means does not fold the section open.
    expect(details?.open).toBe(false);
  });

  test("each layer in the margin carries the mark under its own name", async () => {
    const analysis = {
      version: 4,
      generatedAt: "2026-02-01T00:00:00.000Z",
      model: "test-model",
      inputFingerprint: "fingerprint-1",
      tree: [],
      holding: {
        spans: [{ text: "Model holding sentence.", anchors: [] }],
        language: "cs",
      },
      abstract: {
        spans: [{ text: "Model abstract sentence.", anchors: [] }],
        language: "cs",
      },
      topics: ["Limitation periods"],
    } satisfies DecisionAnalysis;
    render(
      <Providers>
        <AnalysisLayers analysis={analysis} citedLater={false} />
      </Providers>,
    );

    const name = messages.caseLaw.analysis.aiLayer.replace(
      "{layer}",
      () => messages.caseLaw.analysis.topics,
    );
    const mark = screen.getByRole("button", { name });
    expect(mark.closest("h3")).not.toBeNull();

    await act(async () => {
      fireEvent.click(mark);
    });
    expect(await screen.findByText(disclosure)).toBeDefined();
  });
});
