import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { TEXT_FIELD_TYPE } from "@stll/api-contract/case-law-text-field";

import {
  HEADNOTE_VIEW,
  HeadnoteProse,
} from "@/features/case-law/components/decision-cells";
import type { HeadnoteView } from "@/features/case-law/components/decision-cells";
import messages from "@/i18n/langs/en.json";

const PREVIEW = "Nájemní smlouva a výpověď z nájmu bytu…";
const WHOLE =
  "Nájemní smlouva a výpověď z nájmu bytu jsou platné i bez písemného souhlasu druhého manžela.";

/** The clamp the compact density puts on a prose cell. */
const CLAMP = "line-clamp-2";

const render = (node: ReactNode): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </IntlProvider>,
  );

const prose = ({
  truncated,
  view,
}: {
  truncated: boolean;
  view: HeadnoteView;
}): string =>
  render(
    <HeadnoteProse
      columnId="summary"
      contentMode="tight"
      onActivate={() => undefined}
      preview={{ text: PREVIEW, truncated, type: TEXT_FIELD_TYPE.PRESENT }}
      queryTokens={["výpověď"]}
      view={view}
    />,
  );

const collapsed = { type: HEADNOTE_VIEW.COLLAPSED } as const;

describe("a cut headnote can be read whole", () => {
  test("a cut row offers the rest of the line, a complete one offers nothing", () => {
    expect(prose({ truncated: true, view: collapsed })).toContain(
      "Show whole headnote",
    );
    expect(prose({ truncated: false, view: collapsed })).not.toContain(
      "Show whole headnote",
    );
  });

  test("the expanded row shows the whole line, unclamped and still marked", () => {
    const markup = prose({
      truncated: true,
      view: { text: WHOLE, type: HEADNOTE_VIEW.WHOLE },
    });

    expect(markup).toContain("bez písemného souhlasu druhého manžela.");
    expect(markup).not.toContain(CLAMP);
    // The search's words stay marked in the text that replaced the preview.
    expect(markup).toContain("<mark");
    expect(markup).toContain("Show less");
  });

  test("the collapsed row stays clamped to the density the reader chose", () => {
    expect(prose({ truncated: true, view: collapsed })).toContain(CLAMP);
  });

  test("a read that failed says so and offers another try", () => {
    const markup = prose({
      truncated: true,
      view: { type: HEADNOTE_VIEW.FAILED },
    });

    expect(markup).toContain(messages.errors.actionFailed);
    expect(markup).toContain("Retry");
    // The preview is still the text on screen: a failed read loses nothing.
    expect(markup).toContain("Nájemní smlouva");
  });
});
