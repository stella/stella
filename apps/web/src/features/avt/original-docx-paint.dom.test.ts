import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

// Spies created in a test stay attached if it fails before restoring them.
afterEach(() => {
  mock.restore();
});

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { claimUnderPoint, paintClaimRanges, resolveHighlightApi } =
  await import("@/features/avt/original-docx-paint");
const { claimId } = await import("@/features/avt/avt.test-fixtures");

afterEach(() => {
  document.body.replaceChildren();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

/** Folio's painted page: body runs carrying the positions they draw. */
const paintedPage = () => {
  const root = document.createElement("div");
  const content = document.createElement("div");
  content.className = "layout-page-content";
  for (const [pmStart, text] of [
    [1, "The lease was signed on "],
    [25, "3 March 2021"],
    [37, " by both parties."],
  ] as const) {
    const span = document.createElement("span");
    span.dataset["pmStart"] = String(pmStart);
    span.dataset["pmEnd"] = String(pmStart + text.length);
    span.textContent = text;
    content.append(span);
  }
  root.append(content);
  document.body.append(root);
  return root;
};

const signed = claimId(1);
const marks = [
  {
    location: { claimId: signed, blockId: "1A2B3C4D", from: 15, to: 37 },
    state: "supported",
    mark: "active",
  },
] as const;

describe("resolveHighlightApi", () => {
  test("needs both the Highlight constructor and the CSS registry", () => {
    // happy-dom has neither half of the API: both are stood in by doubles of
    // the members the view uses.
    class FakeHighlight {
      priority = 0;
      readonly ranges: readonly Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    const registry = new Map<string, FakeHighlight>();
    const highlights = {
      set: (name: string, highlight: FakeHighlight) =>
        registry.set(name, highlight),
      delete: (name: string) => registry.delete(name),
    };
    const Highlight = FakeHighlight;

    expect(resolveHighlightApi({})).toBeNull();
    expect(resolveHighlightApi({ CSS: { highlights } })).toBeNull();
    expect(resolveHighlightApi({ Highlight })).toBeNull();
    expect(
      resolveHighlightApi({ Highlight, CSS: { highlights: undefined } }),
    ).toBeNull();

    const api = resolveHighlightApi({ Highlight, CSS: { highlights } });
    paintClaimRanges({ root: paintedPage(), marks, scope: "run", api });
    const painted = registry.get("stella-avt-claim-run-supported-active");
    expect(painted).toBeInstanceOf(FakeHighlight);
    expect(painted instanceof FakeHighlight ? painted.priority : null).toBe(2);
  });
});

describe("without the Custom Highlight API", () => {
  test("painting does not throw and a click on a claim's words selects it", () => {
    const api = resolveHighlightApi({});
    expect(api).toBeNull();

    const ranges = paintClaimRanges({
      root: paintedPage(),
      marks,
      scope: "run",
      api,
    });
    expect(
      (ranges.get(signed) ?? []).map((range) => range.toString()).join(""),
    ).toBe("signed on 3 March 2021");

    // happy-dom lays nothing out, so each range reports one box here.
    const getClientRects = spyOn(
      Range.prototype,
      "getClientRects",
    ).mockImplementation(() => {
      const box = new DOMRect(100, 40, 120, 16);
      return Object.assign([box], {
        item: () => box,
      });
    });
    expect(claimUnderPoint(ranges, { x: 150, y: 48 })).toBe(signed);
    expect(claimUnderPoint(ranges, { x: 10, y: 48 })).toBeNull();
    getClientRects.mockRestore();
  });
});
