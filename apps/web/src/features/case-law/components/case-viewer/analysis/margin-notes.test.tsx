import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { MarginNotes } from "@/features/case-law/components/case-viewer/analysis/margin-notes";
import type { MarginItem } from "@/features/case-law/components/case-viewer/analysis/margin-notes";
import messages from "@/i18n/langs/en.json";

const renderInline = (items: MarginItem[]): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <MarginNotes items={items} placement="inline" />
    </IntlProvider>,
  );

const analysisNote: MarginItem = {
  category: "reasoning",
  depth: 0,
  id: "note-1",
  kind: "annotation",
  startAnchorId: "p-1",
  text: "What the model made of the paragraph.",
};

const ownComment: MarginItem = {
  author: { image: null, name: "Reader" },
  id: "comment-1",
  kind: "comment",
  mine: true,
  onDelete: () => undefined,
  onToggleVisibility: () => undefined,
  startAnchorId: "p-1",
  text: "My own words.",
  visibility: "private",
};

describe("notes drawn in the text's own flow", () => {
  // The inline note is already at its anchor, so there is nothing to jump to.
  test("an analysis note is read, not operated", () => {
    expect(renderInline([analysisNote])).not.toContain("<button");
  });

  // The inline layout is what a touch screen gets, and there is no hover
  // there to reveal anything.
  test("a reader's own comment keeps its controls on screen", () => {
    const markup = renderInline([ownComment]);

    expect(markup).toContain(messages.common.delete);
    expect(markup).not.toContain("opacity-0");
  });
});
