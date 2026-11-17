import { useState } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost/law" });
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { LawEntryBox } = await import("./law-entry-box");

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const Entry = ({
  onSubmit,
  initial = "",
}: {
  onSubmit: () => void;
  initial?: string;
}) => {
  const [query, setQuery] = useState(initial);
  return (
    <LawEntryBox
      askScope={null}
      maxLength={SEARCH_QUERY_MAX_LENGTH}
      onQueryChange={setQuery}
      onSubmit={onSubmit}
      pickers={<span />}
      placeholder="Search the law"
      query={query}
      searchLabel="Search"
      status={<span />}
    />
  );
};

test("keeps controlled text, input limits, direction and submit availability", () => {
  let submitted = 0;
  const view = render(
    <Entry
      onSubmit={() => {
        submitted += 1;
      }}
    />,
  );
  const input = view.getByRole("textbox", { name: "Search" });
  const submit = view.getByRole("button", { name: "Search" });
  expect(input).toHaveProperty("maxLength", SEARCH_QUERY_MAX_LENGTH);
  expect(input.getAttribute("rows")).toBe("1");
  expect(input).toHaveProperty("autocomplete", "off");
  expect(submit.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(submit);
  expect(submitted).toBe(0);
  fireEvent.change(input, { target: { value: "قانون العمل" } });
  expect(input).toHaveProperty("value", "قانون العمل");
  expect(input.getAttribute("dir")).toBe("auto");
  expect(submit.getAttribute("aria-disabled")).toBeNull();
  fireEvent.change(input, { target: { value: "   " } });
  expect(submit.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(submit);
  expect(submitted).toBe(0);
});

test("Enter submits once while Shift+Enter and IME confirmation keep editing", () => {
  let submitted = 0;
  const view = render(
    <Entry
      initial="Employment law"
      onSubmit={() => {
        submitted += 1;
      }}
    />,
  );
  const input = view.getByRole("textbox", { name: "Search" });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(submitted).toBe(0);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(submitted).toBe(1);
  fireEvent.click(view.getByRole("button", { name: "Search" }));
  expect(submitted).toBe(2);
});
