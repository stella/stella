import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "https://app.example.test" });

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// The dataset lint autofix turns attribute presence checks into own-property
// checks on `dataset`. Browsers treat valueless data attributes as present, so
// the DOM test environment must agree.
test.each([
  ["valueless", "<div data-copy-exclude></div>"],
  ["empty", '<div data-copy-exclude=""></div>'],
  ["valued", '<div data-copy-exclude="true"></div>'],
])("a %s data attribute is an own dataset property", (_label, markup) => {
  const host = document.createElement("div");
  // safe-html: constant markup from the test table above
  host.innerHTML = markup;
  const element = host.firstElementChild;
  if (!(element instanceof HTMLElement)) {
    throw new Error("expected an element");
  }

  expect(Object.hasOwn(element.dataset, "copyExclude")).toBe(true);
  expect(Object.keys(element.dataset)).toEqual(["copyExclude"]);
});

test("a missing data attribute is not an own dataset property", () => {
  const element = document.createElement("div");

  expect(Object.hasOwn(element.dataset, "copyExclude")).toBe(false);
  expect(Object.keys(element.dataset)).toEqual([]);
});
