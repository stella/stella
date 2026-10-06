import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { UI_LOCALES } from "@stll/locales";

import arabic from "@/i18n/langs/ar.json";
import english from "@/i18n/langs/en.json";

import type { RegisteredChatUIToolCallPart } from "./chat-ui-tools";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const { SpawnSubagentsCard } = await import("./spawn-subagents-card");

afterEach(() => cleanup());
afterAll(async () => GlobalRegistrator.unregister());

const task =
  "Review matter 019dd47d-f507-7c84-b827-980af11b8980. documentId=internal-document. No writes.";
const title = "Civil Code §§ 576–588";
const result =
  "### Verified provisions\n\n- **Invalidity:** see [Civil Code](https://example.test/eli/cz/sb/2012/89).";
const part = {
  type: "tool-call",
  name: "spawn_subagents",
  id: "subagent-run",
  state: "complete",
  arguments: "{}",
  input: { subagents: [{ title, task }] },
  output: { results: [{ index: 0, status: "completed", result }] },
} satisfies RegisteredChatUIToolCallPart;

const TEST_LOCALES = UI_LOCALES.filter(
  (locale) => locale === "en" || locale === "ar",
);

const mountCard = (
  locale: (typeof TEST_LOCALES)[number] = "en",
  cardPart: ComponentProps<typeof SpawnSubagentsCard>["part"] = part,
) =>
  render(
    <IntlProvider
      locale={locale}
      messages={locale === "ar" ? arabic : english}
      timeZone="UTC"
    >
      <FormattingProvider locale={locale} timeZone="UTC">
        <SpawnSubagentsCard
          part={cardPart}
          streamdownComponents={{
            a: ({ children, ...props }) => <a {...props}>{children}</a>,
          }}
        />
      </FormattingProvider>
    </IntlProvider>,
  );

test.each(TEST_LOCALES)(
  "%s card shows only the supplied human title until expanded",
  async (locale) => {
    const view = mountCard(locale);
    const row = view.getByRole("button", { name: new RegExp(title, "u") });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent).not.toContain(task);
    expect(view.container.textContent).not.toContain("019dd47d");
    expect(
      view.queryByRole("heading", { name: "Verified provisions" }),
    ).toBeNull();
    fireEvent.click(row);
    await waitFor(() => expect(row.getAttribute("aria-expanded")).toBe("true"));
    await waitFor(() =>
      expect(
        view.getByRole("heading", { name: "Verified provisions" }).tagName,
      ).toBe("H3"),
    );
    await waitFor(() => {
      expect(
        view.getByRole("link", { name: "Civil Code" }).getAttribute("href"),
      ).toBe("https://example.test/eli/cz/sb/2012/89");
      expect(
        view.getByText("Invalidity:", {
          selector: 'li [data-streamdown="strong"]',
        }).textContent,
      ).toBe("Invalidity:");
    });
    expect(view.container.textContent).not.toContain("###");
    expect(view.container.textContent).not.toContain("**");

    const inputLabel = (locale === "ar" ? arabic : english).chat.toolCall.input;
    const promptToggle = view.getByRole("button", { name: inputLabel });
    expect(promptToggle.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.textContent).not.toContain("No writes.");
    fireEvent.click(promptToggle);
    await waitFor(() =>
      expect(view.getByText(/No writes\./u).textContent).toContain("[…]"),
    );
    expect(view.container.textContent).not.toContain("019dd47d");
    expect(view.container.textContent).not.toContain("internal-document");
    expect(view.container.textContent).toContain("No writes.");
  },
);

const error =
  "Cannot review documentId=private-document for matter 019dd47d-f507-7c84-b827-980af11b8980. Please retry.";
const failedPart = {
  type: "tool-call",
  name: "spawn_subagents",
  id: "failed-subagent-run",
  state: "complete",
  arguments: "{}",
  input: { subagents: [{ title, task }] },
  output: { results: [{ index: 0, status: "failed", error }] },
} satisfies RegisteredChatUIToolCallPart;
const runningPart = {
  type: "tool-call",
  name: "spawn_subagents",
  id: "running-subagent-run",
  state: "input-complete",
  arguments: "{}",
  input: { subagents: [{ title, task }] },
} satisfies RegisteredChatUIToolCallPart;

test.each(TEST_LOCALES)(
  "%s failed subagent exposes its error with technical identifiers masked",
  async (locale) => {
    const catalog = locale === "ar" ? arabic : english;
    const view = mountCard(locale, failedPart);
    const row = view.getByRole("button", { name: new RegExp(title, "u") });
    expect(row.textContent).toContain(catalog.common.failed);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByText(/Please retry\./u)).toBeNull();
    fireEvent.click(row);
    await waitFor(() => {
      expect(
        view.getByText(
          "Cannot review documentId=[…] for matter […]. Please retry.",
        ).textContent,
      ).toBe("Cannot review documentId=[…] for matter […]. Please retry.");
    });
    expect(view.container.textContent).not.toContain("private-document");
    expect(view.container.textContent).not.toContain(
      "019dd47d-f507-7c84-b827-980af11b8980",
    );
    expect(
      view.queryByRole("heading", { name: "Verified provisions" }),
    ).toBeNull();
  },
);

test.each(TEST_LOCALES)(
  "%s running subagent keeps a pending indicator without a completed result",
  async (locale) => {
    const catalog = locale === "ar" ? arabic : english;
    const view = mountCard(locale, runningPart);
    const row = view.getByRole("button", { name: new RegExp(title, "u") });
    expect(row.textContent).toContain(catalog.tasks.statusValues.in_progress);
    expect(row.querySelector("svg.animate-spin")).not.toBeNull();
    expect(row.textContent).not.toContain(catalog.common.done);
    expect(row.textContent).not.toContain(catalog.common.failed);
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    await waitFor(() => expect(row.getAttribute("aria-expanded")).toBe("true"));
    expect(
      view.queryByRole("heading", { name: "Verified provisions" }),
    ).toBeNull();
    expect(view.container.textContent).not.toContain(task);
  },
);
