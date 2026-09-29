import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

// A DOM for this file only: the notes are rendered for real and the column's
// click is answered from the elements a reader actually hits.
GlobalRegistrator.register({ url: "http://localhost:3000/law" });

const { cleanup, isInaccessible, render, within } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { MarginNotes } =
  await import("@/features/case-law/components/case-viewer/analysis/margin-notes");
const { clickOpensVisitorOffer, READER_ASIDE_RESIZE_SLOT } =
  await import("@/features/case-law/components/case-viewer/decision-workspace.logic");
const { default: messages } = await import("@/i18n/langs/en.json");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const EXAMPLE_HEADING = "Facts";
const COMMENT_TEXT = "My own words.";

/** The mix a visitor's column holds: an example note beside a comment they
 *  wrote without an account and one they are writing now. */
const renderVisitorColumn = () =>
  render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <aside>
        <MarginNotes
          items={[
            {
              category: "facts",
              depth: 0,
              heading: EXAMPLE_HEADING,
              id: "example:facts",
              kind: "example",
              lines: [0.8, 0.4],
              startAnchorId: "p-1",
            },
            {
              author: { image: null, name: "Visitor" },
              id: "comment-1",
              kind: "comment",
              mine: true,
              onDelete: () => undefined,
              onToggleVisibility: () => undefined,
              startAnchorId: "p-2",
              text: COMMENT_TEXT,
              visibility: "private",
            },
            {
              id: "composer",
              kind: "composer",
              onCancel: () => undefined,
              onSubmit: () => undefined,
              startAnchorId: "p-3",
            },
          ]}
          placement="inline"
        />
        <div data-slot={READER_ASIDE_RESIZE_SLOT} data-testid="resize" />
      </aside>
    </IntlProvider>,
  );

const FOCUSABLE =
  "a[href], button, input, select, textarea, [tabindex], [contenteditable]";

describe("the visitor's notes column", () => {
  test("never asks for an account from the reader's own comments", () => {
    const view = renderVisitorColumn();
    const form = view.container.querySelector("form");
    const comment = view.getByText(COMMENT_TEXT).parentElement;
    if (form === null || comment === null) {
      throw new Error("the comment notes did not render");
    }
    const controls = [
      ...form.querySelectorAll(FOCUSABLE),
      ...comment.querySelectorAll(FOCUSABLE),
      form,
      view.getByText(COMMENT_TEXT),
    ];

    // Composer textarea, visibility toggle, Cancel, Save; the comment's
    // visibility toggle and Delete.
    expect(controls.length).toBeGreaterThanOrEqual(8);
    for (const control of controls) {
      expect(clickOpensVisitorOffer(control)).toBe(false);
    }
  });

  test("asks from the column's surface and its example notes", () => {
    const view = renderVisitorColumn();
    const aside = view.container.querySelector("aside");

    expect(clickOpensVisitorOffer(aside)).toBe(true);
    expect(clickOpensVisitorOffer(view.getByText(EXAMPLE_HEADING))).toBe(true);
    expect(clickOpensVisitorOffer(view.getByTestId("resize"))).toBe(false);
  });

  test("draws example notes as decoration, out of the tab order and the accessibility tree", () => {
    const view = renderVisitorColumn();
    const heading = view.getByText(EXAMPLE_HEADING);
    const example = heading.closest('[aria-hidden="true"]');

    expect(example).not.toBeNull();
    expect(example?.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    expect(example?.matches(FOCUSABLE)).toBe(false);
    expect(
      within(view.container).queryByRole("button", { name: EXAMPLE_HEADING }),
    ).toBeNull();
    expect(isInaccessible(heading)).toBe(true);
  });
});
