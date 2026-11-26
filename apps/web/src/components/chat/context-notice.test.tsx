import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import type { ChatMessageMetadata } from "@/components/chat/chat-ui-tools";
import {
  ContextNotice,
  LocalRunNotices,
} from "@/components/chat/context-notice";
import { shownLocalRunNotices } from "@/components/chat/local-run-notices.logic";
import messages from "@/i18n/langs/en.json";

const render = (metadata: ChatMessageMetadata | undefined) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <ContextNotice metadata={metadata} />
    </IntlProvider>,
  );

describe("an answer's context notice", () => {
  test("says that earlier history was left out of the answer's context", () => {
    const markup = render({ contextNotice: { type: "history-trimmed" } });

    expect(markup).toContain('role="status"');
    expect(markup).toContain(messages.chat.historyTrimmed);
  });

  test("says the coding agent started over from the chat's messages", () => {
    const markup = render({ contextNotice: { type: "session-not-resumed" } });

    expect(markup).toContain('role="status"');
    expect(markup).toContain(
      messages.chat.localRun.sessionNotResumed.replace("'", "&#x27;"),
    );
  });

  test("stays hidden on an answer whose context left nothing out", () => {
    expect(render(undefined)).toBe("");
    expect(render({})).toBe("");
  });

  test("stays hidden once the live stream withdraws a replaced attempt's notice", () => {
    expect(render({ contextNotice: null })).toBe("");
  });
});

const renderNotices = (
  metadata: ChatMessageMetadata | undefined,
  isTurnActive = true,
) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <LocalRunNotices isTurnActive={isTurnActive} metadata={metadata} />
    </IntlProvider>,
  );

const { notices } = messages.chat.localRun;

const EMPTY_REGION =
  '<span aria-live="polite" class="sr-only" role="status"></span>';

describe("what an answer's local run said about itself", () => {
  test("reads each notice as one quiet line in one polite live region", () => {
    const markup = renderNotices({
      localRunNotices: [
        { kind: "config_warning" },
        { kind: "capability_unavailable", capability: "browser" },
        { kind: "retrying", status: "retrying", attempt: 2, maxAttempts: 5 },
      ],
    });

    expect(markup.match(/role="status"/gu)).toHaveLength(1);
    expect(markup).toContain('aria-live="polite"');
    expect(markup.match(/<p /gu)).toHaveLength(3);
    // Read once, by the live region; the visible lines are not read again.
    expect(markup.split(notices.configWarning)).toHaveLength(3);
    expect(markup).toContain('<div aria-hidden="true">');
    expect(markup).toContain(notices.browserUnavailable);
    expect(markup).toContain("is trying again (attempt 2 of 5).");
  });

  test("a retry without a count reads without one, and a recovered one says so", () => {
    expect(
      renderNotices({
        localRunNotices: [
          {
            kind: "retrying",
            status: "retrying",
            attempt: null,
            maxAttempts: null,
          },
        ],
      }),
    ).toContain(notices.retrying);
    const recovered = renderNotices({
      localRunNotices: [
        { kind: "retrying", status: "recovered", attempt: 2, maxAttempts: 5 },
      ],
    });
    expect(recovered).toContain(notices.recovered);
    expect(recovered).not.toContain(notices.retrying);
  });

  test("a retry that ended with its turn leaves only the region, which says nothing", () => {
    const markup = renderNotices({
      localRunNotices: [
        { kind: "retrying", status: "ended", attempt: 1, maxAttempts: 5 },
      ],
    });
    expect(markup).toBe(EMPTY_REGION);
  });

  test("a retry still under way when the turn stopped running reads as ended", () => {
    const metadata: ChatMessageMetadata = {
      localRunNotices: [
        { kind: "config_warning" },
        { kind: "retrying", status: "retrying", attempt: 2, maxAttempts: 5 },
      ],
    };
    expect(renderNotices(metadata)).toContain("(attempt 2 of 5)");
    const stopped = renderNotices(metadata, false);
    expect(stopped).not.toContain("trying again");
    expect(stopped).toContain(notices.configWarning);
  });

  test("an answer whose run said nothing holds only the empty region, so its first notice is announced", () => {
    expect(renderNotices(undefined)).toBe(EMPTY_REGION);
    expect(renderNotices({})).toBe(EMPTY_REGION);
    expect(renderNotices({ localRunNotices: [] })).toBe(EMPTY_REGION);
  });
});

describe("whether an earlier answer draws its run's notices", () => {
  test("goes by the notices it shows, not by the metadata it carries", () => {
    expect(shownLocalRunNotices({ localRunNotices: [] }, false)).toEqual([]);
    expect(
      shownLocalRunNotices(
        {
          localRunNotices: [
            {
              kind: "retrying",
              status: "retrying",
              attempt: 1,
              maxAttempts: 5,
            },
          ],
        },
        false,
      ),
    ).toEqual([]);
    expect(
      shownLocalRunNotices(
        { localRunNotices: [{ kind: "config_warning" }] },
        false,
      ),
    ).toEqual([{ kind: "config_warning" }]);
  });
});
