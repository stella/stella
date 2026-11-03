import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register();

const { writeScrollEdgeFade } = await import("./scroll-edge-fade");

afterAll(async () => GlobalRegistrator.unregister());

type ScrollerOptions = {
  direction: "ltr" | "rtl";
  scrollLeft: number;
  scrollWidth: number;
};

const scroller = ({ direction, scrollLeft, scrollWidth }: ScrollerOptions) => {
  const node = document.createElement("div");
  // Computed direction is resolved only for a connected element.
  document.body.append(node);
  node.style.direction = direction;
  Object.defineProperties(node, {
    clientWidth: { value: 100 },
    scrollLeft: { value: scrollLeft },
    scrollWidth: { value: scrollWidth },
  });
  writeScrollEdgeFade(node);
  return [
    node.style.getPropertyValue("--scroll-fade-left"),
    node.style.getPropertyValue("--scroll-fade-right"),
  ];
};

test("fades only the physical edges with content behind them, capped", () => {
  const ltr = { direction: "ltr", scrollWidth: 300 } as const;
  expect(scroller({ ...ltr, scrollLeft: 0 })).toEqual(["0px", "64px"]);
  expect(scroller({ ...ltr, scrollLeft: 100 })).toEqual(["64px", "64px"]);
  expect(scroller({ ...ltr, scrollLeft: 190 })).toEqual(["64px", "10px"]);
  expect(scroller({ ...ltr, scrollLeft: 200 })).toEqual(["64px", "0px"]);
  expect(
    scroller({ direction: "ltr", scrollLeft: 0, scrollWidth: 100 }),
  ).toEqual(["0px", "0px"]);
});

test("mirrors a right-to-left scroller, which starts at its right edge", () => {
  const rtl = { direction: "rtl", scrollWidth: 300 } as const;
  expect(scroller({ ...rtl, scrollLeft: 0 })).toEqual(["64px", "0px"]);
  expect(scroller({ ...rtl, scrollLeft: -170 })).toEqual(["30px", "64px"]);
  expect(scroller({ ...rtl, scrollLeft: -200 })).toEqual(["0px", "64px"]);
});

test("leaves the style untouched while the capped widths hold", () => {
  const node = document.createElement("div");
  let scrollLeft = 100;
  Object.defineProperties(node, {
    clientWidth: { value: 100 },
    scrollLeft: { get: () => scrollLeft },
    scrollWidth: { value: 400 },
  });
  writeScrollEdgeFade(node);
  const writes: string[] = [];
  const setProperty = node.style.setProperty.bind(node.style);
  node.style.setProperty = (name, value) => {
    writes.push(name);
    setProperty(name, value);
  };
  scrollLeft = 150;
  writeScrollEdgeFade(node);
  expect(writes).toEqual([]);
  scrollLeft = 290;
  writeScrollEdgeFade(node);
  expect(writes).toEqual(["--scroll-fade-right"]);
});
