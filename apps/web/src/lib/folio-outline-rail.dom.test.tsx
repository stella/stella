import type { ComponentProps } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { installRenderProbe } from "@stll/render-probe";
import { formatRenderReport } from "@stll/render-probe/report";
import { reactCompilerBunPlugin } from "@stll/scripts/src/react-compiler-bun-plugin";

import { unregisterDomEnvironment } from "@/test-dom-environment";

// The outline the docx editor shows, through the app's folio adapter and the
// design-system rail. Folio rebuilds its heading list after every edit: first
// without page numbers, then with them once the relayout resolves them. The
// render probe counts what each such update renders.
GlobalRegistrator.register({ url: "http://localhost:3000/document" });
// React DOM reads its DevTools hook once, when it loads.
const probe = installRenderProbe();
// Rendered as it ships, compiled by the React Compiler.
Bun.plugin(reactCompilerBunPlugin);

const { act, cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { folioUIComponents } = await import("@/lib/folio-ui-components");
const { bundledEnglishMessages } = await import("@/i18n/i18n-store");

type FolioOutlineRailProps = ComponentProps<
  NonNullable<typeof folioUIComponents.OutlineRail>
>;
type FolioOutlineItem = FolioOutlineRailProps["items"][number];

const FolioOutlineRail =
  folioUIComponents.OutlineRail ?? panic("The app binds no outline rail");

// The design-system rail's row; every outline entry renders one.
const OUTLINE_ROW = "OutlineRowView";

const SECTION_TITLES = ["Definitions", "Waiver", "Notices", "Assignment"];

/** A folio heading list: each section a heading with three subheadings. */
const headings = (count: number): FolioOutlineItem[] =>
  Array.from({ length: count }, (_, index) => {
    const section = Math.floor(index / 4);
    const level = index % 4 === 0 ? 0 : 1;
    const title = SECTION_TITLES[section % SECTION_TITLES.length] ?? "";
    return {
      id: String(10 + index * 37),
      label:
        level === 0
          ? `${String(section + 1)}. ${title}`
          : `${String(section + 1)}.${String(index % 4)} ${title}`,
      level,
      meta: String(1 + Math.floor(index / 3)),
    };
  });

/** What folio emits right after an edit: the same headings, no pages yet. */
const recollected = (items: FolioOutlineItem[]): FolioOutlineItem[] =>
  items.map(({ id, label, level }) => ({ id, label, level }));

/** The relayout's fill: new objects, page numbers resolved again. */
const refilled = (items: FolioOutlineItem[]): FolioOutlineItem[] =>
  items.map((item) => ({ ...item }));

// Folio hands the rail one ref for the editor's lifetime.
const scrollContainerRef = { current: document.createElement("div") };

const Outline = ({
  items,
  activeId,
}: {
  items: FolioOutlineItem[];
  activeId: string | null;
}) => (
  <IntlProvider locale="en" messages={bundledEnglishMessages} timeZone="UTC">
    <FolioOutlineRail
      activeId={activeId}
      ariaLabel="Document outline"
      items={items}
      onJump={() => undefined}
      presentation="panel"
      resolvePct={() => 50}
      scrollContainerRef={scrollContainerRef}
    />
  </IntlProvider>
);

const pageButtons = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Page "]',
    ),
  );

const rowRenders = () => {
  const snapshot = probe.snapshot();
  return {
    rows: snapshot.components[OUTLINE_ROW]?.renders ?? 0,
    total: snapshot.renders,
    report: formatRenderReport(snapshot),
  };
};

afterEach(async () => {
  await act(async () => {
    cleanup();
  });
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

describe("docx outline rows", () => {
  test("an edit that moves no heading renders no row and keeps every page number node", () => {
    const items = headings(24);
    const mounted = render(<Outline activeId={null} items={items} />);
    const before = pageButtons(mounted.container);
    expect(before).toHaveLength(items.length);
    expect(rowRenders().rows).toBeGreaterThan(0);

    probe.reset();
    mounted.rerender(<Outline activeId={null} items={recollected(items)} />);
    mounted.rerender(<Outline activeId={null} items={refilled(items)} />);
    mounted.rerender(<Outline activeId={null} items={refilled(items)} />);

    const { rows, report } = rowRenders();
    expect(rows, report).toBe(0);
    const after = pageButtons(mounted.container);
    expect(after).toHaveLength(before.length);
    expect(after.every((button, index) => button === before[index])).toBe(true);
    expect(after.map((button) => button.textContent)).toEqual(
      items.map((item) => item.meta ?? ""),
    );
  });

  test("a relayout that moves one heading renders that row alone", () => {
    const items = headings(24);
    const mounted = render(<Outline activeId={null} items={items} />);
    const moved = items.at(9) ?? panic("Fixture has a tenth heading");

    probe.reset();
    mounted.rerender(<Outline activeId={null} items={recollected(items)} />);
    mounted.rerender(
      <Outline
        activeId={null}
        items={refilled(items).map((item) =>
          item.id === moved.id ? { ...item, meta: "40" } : item,
        )}
      />,
    );

    const { rows, report } = rowRenders();
    expect(rows, report).toBe(1);
    expect(pageButtons(mounted.container).at(9)?.textContent).toBe("40");
  });

  // A jump moves the active heading, and the scroll that follows moves it on
  // past every heading it crosses. Each move must cost the rows it changes,
  // not the outline's length: the counts are equal at N and 10N.
  test("an active heading change renders the two rows it changes at any outline length", () => {
    const measure = (count: number) => {
      const items = headings(count);
      const from = items.at(1)?.id ?? panic("Fixture has a second heading");
      const to = items.at(-2)?.id ?? panic("Fixture has a last heading");
      const mounted = render(<Outline activeId={from} items={items} />);
      probe.reset();
      mounted.rerender(<Outline activeId={to} items={refilled(items)} />);
      const measured = rowRenders();
      mounted.unmount();
      return measured;
    };

    const small = measure(24);
    const large = measure(240);

    expect(small.rows, small.report).toBe(2);
    expect(large.rows, large.report).toBe(2);
    expect(large.total, large.report).toBe(small.total);
  });
});
