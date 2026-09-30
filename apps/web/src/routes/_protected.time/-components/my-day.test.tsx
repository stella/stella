import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";

import { FormattingProvider } from "@/i18n/formatting-context";
import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";

import { MyDayRow } from "./my-day-row";
import { MyDayTotals } from "./my-day-totals";
import {
  summarizeMyDay,
  type MyDayEntry,
  type MyDayPage,
} from "./my-day.logic";

const client = {
  activityGroup: "client",
  id: toSafeId<"timeEntry">("00000000-0000-4000-8000-000000000001"),
  workspaceId: toSafeId<"workspace">("00000000-0000-4000-8000-000000000002"),
  workspaceName: "Contract review",
  workspaceReference: "MAT-42",
  narrative: "Review liability provisions",
  dateWorked: "2026-10-04",
  durationMinutes: 90,
  billedMinutes: 120,
  billable: true,
  status: "draft",
  source: "manual",
  timerStartedAt: null,
} as const satisfies MyDayEntry;

const internal = {
  activityGroup: "internal",
  id: toSafeId<"timeEntry">("00000000-0000-4000-8000-000000000003"),
  workspaceId: null,
  workspaceName: null,
  workspaceReference: null,
  narrative: "Team training",
  dateWorked: "2026-10-04",
  durationMinutes: 30,
  billedMinutes: 0,
  billable: false,
  status: "draft",
  source: "manual",
  timerStartedAt: null,
} as const satisfies MyDayEntry;

const absence = {
  activityGroup: "absence",
  id: toSafeId<"absence">("00000000-0000-4000-8000-000000000004"),
  kind: "vacation",
  coverage: "half",
  halfDaySegment: "morning",
  days: 0.5,
  date: "2026-10-04",
  startDate: "2026-10-04",
  endDate: "2026-10-05",
  timezoneId: "Europe/Prague",
} as const satisfies MyDayEntry;

const page = (items: MyDayEntry[], nextCursor: string | null = null) =>
  ({
    items,
    nextCursor,
    limit: 50,
  }) satisfies MyDayPage;

const COMPLETE_PAGES = [page([client]), page([internal, absence])];

test("My Day totals keep client minutes, internal minutes and absence days separate", () => {
  expect(summarizeMyDay(COMPLETE_PAGES)).toEqual({
    client: { minutes: 90, running: false },
    internal: { minutes: 30, running: false },
    absence: { days: 0.5 },
  });
  expect(summarizeMyDay([page([absence, internal, client])])).toEqual(
    summarizeMyDay(COMPLETE_PAGES),
  );
});

test.each([0, 90, 999])(
  "My Day never counts a running timer's stored %i minutes as completed work",
  (durationMinutes) => {
    expect(
      summarizeMyDay([
        page([
          client,
          internal,
          {
            ...client,
            durationMinutes,
            timerStartedAt: "2026-10-04T09:00:00Z",
          },
          {
            ...internal,
            durationMinutes,
            timerStartedAt: "2026-10-04T09:00:00Z",
          },
        ]),
      ]),
    ).toEqual({
      client: { minutes: 90, running: true },
      internal: { minutes: 30, running: true },
      absence: { days: 0 },
    });
  },
);

test("My Day totals remain unavailable until the final page arrives", () => {
  expect(summarizeMyDay([])).toBeNull();
  expect(summarizeMyDay([page([client], "more")])).toBeNull();
  expect(
    summarizeMyDay([page([client], "more"), page([internal, absence])]),
  ).toEqual(summarizeMyDay(COMPLETE_PAGES));
});

test.each([
  { locale: "en", messages: en },
  { locale: "ar", messages: ar },
])(
  "My Day renders all three groups in $locale without billing labels on internal work",
  ({ locale, messages }) => {
    const render = (entry: MyDayEntry) =>
      renderToStaticMarkup(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <FormattingProvider
            locale={locale === "ar" ? "ar-u-nu-arab" : locale}
            timeZone="UTC"
          >
            <ul>
              <MyDayRow
                entry={entry}
                renderMatter={(matter) => (
                  <a href={`/workspaces/${matter.workspaceId}/timesheets`}>
                    <BidiText>{matter.workspaceName}</BidiText>
                  </a>
                )}
              />
            </ul>
          </FormattingProvider>
        </IntlProvider>,
      );
    const clientHtml = render(client);
    const internalHtml = render(internal);
    const absenceHtml = render(absence);
    expect(clientHtml).toContain("Contract review");
    expect(clientHtml).toContain(messages.billing.clientWork);
    expect(clientHtml).toContain(messages.billing.billable);
    expect(internalHtml).toContain(messages.timesheets.day.internalWork);
    expect(internalHtml).not.toContain(messages.billing.nonBillable);
    expect(internalHtml).not.toContain("href=");
    expect(absenceHtml).toContain(
      messages.timesheets.day.absenceKinds.vacation,
    );
    expect(absenceHtml).toContain(
      messages.timesheets.day.halfDaySegments.morning,
    );
    expect(absenceHtml.replace(/<[^>]*>/gu, "")).not.toContain(" min");
  },
);

test.each([
  { locale: "en", messages: en },
  { locale: "ar", messages: ar },
])(
  "My Day summary renders localized units only for complete data in $locale",
  ({ locale, messages }) => {
    const render = (pages: MyDayPage[]) =>
      renderToStaticMarkup(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <FormattingProvider
            locale={locale === "ar" ? "ar-u-nu-arab" : locale}
            timeZone="UTC"
          >
            <MyDayTotals pages={pages} />
          </FormattingProvider>
        </IntlProvider>,
      );
    expect(render([page([client], "more")])).toBe("");
    const html = render(COMPLETE_PAGES);
    expect(html).toContain(messages.billing.clientWork);
    expect(html).toContain(messages.timesheets.day.internalWork);
    expect(html).toContain(messages.timesheets.day.absence);
    expect(html).toContain(locale === "ar" ? "٩٠" : "90");
    expect(html).toContain(locale === "ar" ? "٠٫٥" : "0.5");
    expect(html).not.toContain("NaN");
    expect(html.match(/<dd /gu)).toHaveLength(3);
  },
);

test("My Day running rows show their state instead of a provisional duration", () => {
  const html = renderToStaticMarkup(
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <ul>
          <MyDayRow
            entry={{
              ...internal,
              durationMinutes: 999,
              timerStartedAt: "2026-10-04T09:00:00Z",
            }}
            renderMatter={() => null}
          />
        </ul>
      </FormattingProvider>
    </IntlProvider>,
  );
  expect(html).toContain(en.common.running);
  expect(html).not.toContain("999");
  expect(html).not.toContain(en.billing.nonBillable);
});
