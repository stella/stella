import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { ChatTurnDuration } from "@/components/chat/chat-turn-duration";
import {
  getChatTurnDurationMs,
  getChatTurnDurationUnits,
} from "@/components/chat/chat-turn-duration.logic";
import arabicMessages from "@/i18n/langs/ar.json";
import messages from "@/i18n/langs/en.json";

const START = "2026-01-01T00:00:00.000Z";
const NOW = new Date("2026-01-01T00:02:14.000Z");

const renderDuration = (
  timing: Parameters<typeof ChatTurnDuration>[0]["timing"],
) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} now={NOW} timeZone="UTC">
      <ChatTurnDuration timing={timing} />
    </IntlProvider>,
  );

describe("assistant turn duration", () => {
  test("renders the same label while running and after reload", () => {
    const running = renderDuration({
      status: "running",
      durationMs: 0,
      startedAt: START,
    });
    const finished = renderDuration({
      status: "finished",
      durationMs: 134_000,
    });
    expect(running).toContain("Worked for 2m 14s");
    expect(finished).toBe(running);
    expect(finished).toContain("tabular-nums");
    expect(finished).toContain("data-chat-copy-exclude");
  });

  test("counts the resumed span on top of prior active work", () => {
    expect(
      getChatTurnDurationMs(
        { status: "running", durationMs: 4000, startedAt: START },
        NOW.getTime(),
      ),
    ).toBe(138_000);
    expect(renderDuration({ status: "finished", durationMs: 4000 })).toContain(
      "Worked for 4s",
    );
  });

  test("omits labels for malformed timestamps and clock skew", () => {
    expect(
      renderDuration({
        status: "running",
        durationMs: 0,
        startedAt: "unknown",
      }),
    ).toBe("");
    expect(
      renderDuration({
        status: "running",
        durationMs: 0,
        startedAt: "2026-01-01T01:00:00.000Z",
      }),
    ).toBe("");
    for (const durationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(renderDuration({ status: "finished", durationMs })).toBe("");
    }
  });

  test("formats whole elapsed seconds including hours and zero", () => {
    expect(getChatTurnDurationUnits(3_661_999)).toEqual({
      hours: 1,
      minutes: 1,
      seconds: 1,
    });
    expect(renderDuration({ status: "finished", durationMs: 0 })).toContain(
      "Worked for 0s",
    );
    expect(
      renderDuration({ status: "finished", durationMs: 3_661_999 }),
    ).toContain("Worked for 1h 1m 1s");
  });
});

test("renders the Arabic sentence with localized narrow duration units", () => {
  const html = renderToStaticMarkup(
    <IntlProvider
      locale="ar"
      messages={arabicMessages}
      now={NOW}
      timeZone="UTC"
    >
      <ChatTurnDuration timing={{ status: "finished", durationMs: 4000 }} />
    </IntlProvider>,
  );
  expect(html).toMatch(/مدة العمل: 4\s*ث/u);
  expect(html).not.toContain("Worked for");
});
