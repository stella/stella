import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { CHAT_THREAD_PLACEHOLDER_TITLE } from "@stll/api-contract";

import type { ForkProvenance } from "@/features/chat/queries";
import de from "@/i18n/langs/de.json";
import en from "@/i18n/langs/en.json";
import { ChatThreadTestRouter } from "@/lib/chat-thread-test-router";

import { ChatForkedFromBanner } from "./chat-forked-from-banner";

const LOCALES = { de, en } as const;

const render = (
  forkProvenance: ForkProvenance,
  locale: keyof typeof LOCALES = "en",
) =>
  renderToStaticMarkup(
    <ChatThreadTestRouter>
      <IntlProvider locale={locale} messages={LOCALES[locale]} timeZone="UTC">
        <ChatForkedFromBanner forkProvenance={forkProvenance} />
      </IntlProvider>
    </ChatThreadTestRouter>,
  );

describe("chat forked-from banner", () => {
  test("renders nothing for a thread that was never forked", () => {
    expect(render({ type: "none" })).toBe("");
  });

  test("keeps the provenance visible once the source is gone", () => {
    const html = render({ type: "parent-unavailable" });

    expect(html).toContain("Forked from a conversation that is no longer");
    // Nothing to open: the source cannot be reached any more.
    expect(html).not.toContain("<a ");
  });

  test("links a global source at the top-level chat path", () => {
    const html = render({
      threadId: "thread-parent",
      title: "Lease renewal",
      type: "parent",
      workspaceId: null,
    });

    expect(html).toContain('href="/chat/thread-parent"');
    // The title is user text of unknown direction inside a sentence whose
    // direction comes from the UI locale, so it is isolated in a `bdi`.
    expect(html).toContain("Forked from <bdi");
    expect(html).toContain("Lease renewal</bdi>");
  });

  test("links a matter-scoped source under its matter", () => {
    const html = render({
      threadId: "thread-parent",
      title: "Lease renewal",
      type: "parent",
      workspaceId: "matter-1",
    });

    expect(html).toContain('href="/chat/workspaces/matter-1/thread-parent"');
  });

  test("names a still-untitled source the way the thread list does", () => {
    // The stored placeholder is English, so only another locale shows the
    // label being substituted rather than the raw placeholder echoed back.
    const html = render(
      {
        threadId: "thread-parent",
        title: CHAT_THREAD_PLACEHOLDER_TITLE,
        type: "parent",
        workspaceId: null,
      },
      "de",
    );

    expect(html).toContain("Verzweigt von <bdi");
    expect(html).toContain("Neuer Chat</bdi>");
    expect(html).not.toContain(CHAT_THREAD_PLACEHOLDER_TITLE);
  });
});
