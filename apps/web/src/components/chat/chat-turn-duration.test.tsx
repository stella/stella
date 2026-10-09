import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  createChatTurnTimingObserver,
  getChatTurnDurationMs,
  getChatTurnDurationUnits,
} from "@stll/api-contract/chat-turn-duration";

import { ChatTurnDuration } from "@/components/chat/chat-turn-duration";
import { FormattingProvider } from "@/i18n/formatting-context";
import arabicMessages from "@/i18n/langs/ar.json";
import messages from "@/i18n/langs/en.json";

const START = "2026-01-01T00:00:00.000Z";
const NOW = new Date("2026-01-01T00:02:14.000Z");

const renderDuration = (
  timing: Parameters<typeof ChatTurnDuration>[0]["timing"],
) => {
  createChatTurnTimingObserver()(
    [
      {
        id: "duration",
        metadata: { turnTiming: timing },
      },
    ],
    performance.now(),
  );
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} now={NOW} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <ChatTurnDuration timing={timing} />
      </FormattingProvider>
    </IntlProvider>,
  );
};

describe("assistant turn duration", () => {
  test("renders the same label while running and after reload", () => {
    const running = renderDuration({
      status: "running",
      durationMs: 0,
      startedAt: START,
      observedAt: NOW.toISOString(),
      elapsedMs: 134_000,
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
    const timing = {
      status: "running",
      durationMs: 4000,
      startedAt: START,
      observedAt: NOW.toISOString(),
      elapsedMs: 134_000,
    } as const;
    createChatTurnTimingObserver()(
      [
        {
          id: "duration",
          metadata: { turnTiming: timing },
        },
      ],
      100,
    );
    expect(getChatTurnDurationMs(timing, 1100)).toBe(139_000);
    expect(renderDuration({ status: "finished", durationMs: 4000 })).toContain(
      "Worked for 4s",
    );
  });

  test("omits labels for malformed elapsed durations", () => {
    for (const durationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(renderDuration({ status: "finished", durationMs })).toBe("");
      expect(
        renderDuration({
          status: "running",
          durationMs: 0,
          startedAt: START,
          observedAt: NOW.toISOString(),
          elapsedMs: durationMs,
        }),
      ).toBe("");
    }
  });

  test("preserves the receipt anchor across repeated snapshots and label remounts", () => {
    const observe = createChatTurnTimingObserver();
    const timing = {
      status: "running",
      durationMs: 4000,
      elapsedMs: 1000,
      startedAt: START,
      observedAt: NOW.toISOString(),
    } as const;
    const message = {
      id: "duration",
      metadata: { turnTiming: timing },
    } as const;
    // Separate JSON observations from the same server read must share one anchor.
    observe([message], 100);
    const repeated = { ...timing };
    observe([{ ...message, metadata: { turnTiming: repeated } }], 1100);
    expect(getChatTurnDurationMs(repeated, 2100)).toBe(7000);
    const fresh = {
      ...timing,
      elapsedMs: 3000,
      observedAt: "2026-01-01T00:02:16.000Z",
    };
    observe([{ ...message, metadata: { turnTiming: fresh } }], 2100);
    expect(getChatTurnDurationMs(fresh, 3100)).toBe(8000);
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

test("uses the formatting preference for Arabic duration digits and units", () => {
  const html = renderToStaticMarkup(
    <IntlProvider
      locale="ar"
      messages={arabicMessages}
      now={NOW}
      timeZone="UTC"
    >
      <FormattingProvider locale="ar-u-nu-arab" timeZone="UTC">
        <ChatTurnDuration timing={{ status: "finished", durationMs: 4000 }} />
      </FormattingProvider>
    </IntlProvider>,
  );
  expect(html).toMatch(/مدة العمل: ٤\s*ث/u);
  expect(html).not.toContain("Worked for");
});
