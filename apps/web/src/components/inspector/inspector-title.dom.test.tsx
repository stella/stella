import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { InspectorTitle } = await import("./inspector-title");

const NAMED = "Draft the NDA";
const STATIC = "Static title";
const PLACEHOLDER = "Untitled";

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

test("a named title renders in the foreground colour, editable or not", () => {
  const { getByRole, getByText } = render(
    <>
      <InspectorTitle isEmpty={false} onEdit={() => {}}>
        {NAMED}
      </InspectorTitle>
      <InspectorTitle isEmpty={false}>{STATIC}</InspectorTitle>
    </>,
  );

  for (const element of [
    getByRole("button", { name: NAMED }),
    getByText(STATIC),
  ]) {
    expect(element.classList.contains("text-foreground")).toBe(true);
    expect(element.classList.contains("text-muted-foreground")).toBe(false);
  }
});

test("an empty title shows its placeholder muted", () => {
  const { getByRole } = render(
    <InspectorTitle isEmpty onEdit={() => {}}>
      {PLACEHOLDER}
    </InspectorTitle>,
  );

  const title = getByRole("button", { name: PLACEHOLDER });
  expect(title.classList.contains("text-muted-foreground")).toBe(true);
  expect(title.classList.contains("text-foreground")).toBe(false);
});

test("clicking an editable title starts editing", () => {
  const onEdit = mock(() => {});
  const { getByRole } = render(
    <InspectorTitle isEmpty={false} onEdit={onEdit}>
      {NAMED}
    </InspectorTitle>,
  );

  fireEvent.click(getByRole("button", { name: NAMED }));
  expect(onEdit).toHaveBeenCalledTimes(1);
});
