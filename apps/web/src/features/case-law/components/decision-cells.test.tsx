import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { TEXT_FIELD_TYPE } from "@stll/api-contract/case-law-text-field";

import {
  DecisionKeywords,
  HEADNOTE_VIEW,
  HeadnoteProse,
} from "@/features/case-law/components/decision-cells";
import type { HeadnoteView } from "@/features/case-law/components/decision-cells";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";

const PREVIEW = "Nájemní smlouva a výpověď z nájmu bytu…";
const WHOLE =
  "Nájemní smlouva a výpověď z nájmu bytu jsou platné i bez písemného souhlasu druhého manžela.";

/** The clamp the compact density puts on a prose cell. */
const CLAMP = "line-clamp-2";

const render = (node: ReactNode): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        {node}
      </FormattingProvider>
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

  test("the control sits outside the clamped text, never inside it", () => {
    // A control drawn inside a two-line clamp is a control the compact
    // density hides: the reader is offered the rest of the headnote by
    // something they cannot see. The compact row's height is a floor, so
    // this line has room below the clamp (decision-row.tsx).
    const markup = prose({ truncated: true, view: collapsed });

    expect(markup.indexOf("</p>")).toBeLessThan(markup.indexOf("<button"));
    expect(markup.slice(markup.indexOf("</p>"))).not.toContain(CLAMP);
  });

  test("the publisher's numbered points keep their own lines", () => {
    // A headnote written as points is three statements, not one sentence
    // saying three things; the cell has to draw the breaks the API kept.
    const points = "I. Prvni bod.\nII. Druhy bod.\nIII. Treti bod.";
    const markup = prose({
      truncated: false,
      view: { text: points, type: HEADNOTE_VIEW.WHOLE },
    });

    expect(markup).toContain("whitespace-pre-line");
    expect(markup).toContain(points);
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

describe("a classification is drawn as what it is", () => {
  test("each term is its own tag, with the search's words marked inside one", () => {
    const markup = render(
      <DecisionKeywords
        columnId="summary"
        items={["Nájem bytu", "Výpověď"]}
        omitted={0}
        queryTokens={["výpověď"]}
      />,
    );

    // One tag per term, never one line of prose joining them.
    expect(markup.match(/<li/gu)?.length).toBe(2);
    expect(markup).toContain("Nájem bytu");
    expect(markup).toContain("<mark");
    expect(markup).not.toContain("Nájem bytu · Výpověď");
  });

  test("a filing the row could not hold whole says how much it is missing", () => {
    // Eight tags and nothing else reads as the publisher's whole filing; the
    // count is what keeps a part from passing for the thing.
    const markup = render(
      <DecisionKeywords
        columnId="summary"
        items={["Nájem bytu"]}
        omitted={3}
        queryTokens={[]}
      />,
    );

    expect(markup).toContain("+3 more");
  });
});
