import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { ForkProvenance } from "@/features/chat/queries";
import messages from "@/i18n/langs/en.json";
import { chatThreadRoute } from "@/lib/chat-thread-ref";

import { ChatForkedFromBanner } from "./chat-forked-from-banner";

const render = (forkProvenance: ForkProvenance) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ChatForkedFromBanner forkProvenance={forkProvenance} />
    </IntlProvider>,
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

  test("routes a global source to the top-level chat path", () => {
    expect(
      chatThreadRoute({ threadId: "thread-parent", workspaceId: null }),
    ).toEqual({
      to: "/chat/$threadId",
      params: { threadId: "thread-parent" },
    });
  });

  test("routes a matter-scoped source under its matter", () => {
    expect(
      chatThreadRoute({ threadId: "thread-parent", workspaceId: "matter-1" }),
    ).toEqual({
      to: "/chat/workspaces/$workspaceId/$threadId",
      params: { workspaceId: "matter-1", threadId: "thread-parent" },
    });
  });
});
