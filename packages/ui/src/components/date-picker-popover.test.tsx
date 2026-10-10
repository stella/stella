import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { DatePickerPopover } from "./date-picker-popover";

const noop = () => undefined;

/** The popup portals on open, so the trigger is the only server-rendered button. */
const triggerTag = (markup: string): string =>
  /<button[^>]*>/u.exec(markup)?.[0] ?? "";

describe("DatePickerPopover trigger", () => {
  test("a disabled picker cannot be opened", () => {
    const trigger = triggerTag(
      renderToStaticMarkup(
        <DatePickerPopover disabled onChange={noop} value="2026-03-05" />,
      ),
    );

    expect(trigger).toContain(" disabled=");
    expect(trigger).toContain("data-disabled");
  });

  test("merges the host's classes into the trigger", () => {
    const trigger = triggerTag(
      renderToStaticMarkup(
        <DatePickerPopover className="w-40" onChange={noop} value={null} />,
      ),
    );

    expect(trigger).toContain("w-40");
    expect(trigger).not.toContain("w-full");
  });

  test("the field variant shares the select trigger's bordered box", () => {
    const inline = triggerTag(
      renderToStaticMarkup(<DatePickerPopover onChange={noop} value={null} />),
    );
    const field = triggerTag(
      renderToStaticMarkup(
        <DatePickerPopover onChange={noop} value={null} variant="field" />,
      ),
    );

    expect(inline).not.toContain("border-input");
    expect(field).toContain("border-input");
    expect(field).toContain("pointer-coarse:after:min-h-11");
  });

  test("date-time mode shows the time in the locale's own format", () => {
    const czech = renderToStaticMarkup(
      <DatePickerPopover
        locale="cs"
        mode="date-time"
        onChange={noop}
        value="2026-03-05T14:30"
      />,
    );
    const english = renderToStaticMarkup(
      <DatePickerPopover
        locale="en-US"
        mode="date-time"
        onChange={noop}
        value="2026-03-05T14:30"
      />,
    );

    expect(czech).toContain("14:30");
    expect(english).toMatch(/2:30\s?PM/u);
  });

  test("date mode keeps the date-only trigger", () => {
    const markup = renderToStaticMarkup(
      <DatePickerPopover locale="en-US" onChange={noop} value="2026-03-05" />,
    );

    expect(markup).toContain("Mar 5, 2026");
    expect(markup).not.toMatch(/\d:\d{2}/u);
  });

  test("date-time mode reads a Date at its UTC wall-clock time", () => {
    const markup = renderToStaticMarkup(
      <DatePickerPopover
        locale="cs"
        mode="date-time"
        onChange={noop}
        value={new Date(Date.UTC(2026, 2, 5, 14, 30))}
      />,
    );

    expect(markup).toContain("14:30");
  });
});
