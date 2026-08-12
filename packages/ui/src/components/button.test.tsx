import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { Button } from "./button";

// `disabled=""` is what React emits for the native attribute; a button that
// carries it can never be hovered or focused, so its tooltip can never open.
const isNativelyDisabled = (markup: string) => / disabled=""/u.test(markup);
const isAccessiblyDisabled = (markup: string) =>
  markup.includes('aria-disabled="true"');

describe("Button disabled disposition", () => {
  test("a disabled button with no tooltip keeps the native attribute", () => {
    const markup = renderToStaticMarkup(<Button disabled>Save</Button>);

    expect(isNativelyDisabled(markup)).toBe(true);
    expect(isAccessiblyDisabled(markup)).toBe(false);
  });

  test("a disabled button with a tooltip stays reachable instead", () => {
    const markup = renderToStaticMarkup(
      <Button disabled tooltip="Save the draft first">
        Approve
      </Button>,
    );

    expect(isAccessiblyDisabled(markup)).toBe(true);
    expect(isNativelyDisabled(markup)).toBe(false);
    // Disabled still reads as disabled to a sighted user.
    expect(markup).toContain("opacity-64");
    expect(markup).toContain("cursor-not-allowed");
  });

  test("an aria-label is a tooltip too, so it takes the same path", () => {
    const markup = renderToStaticMarkup(
      <Button aria-label="Suggest a title" disabled size="icon-xs" />,
    );

    expect(isAccessiblyDisabled(markup)).toBe(true);
    expect(isNativelyDisabled(markup)).toBe(false);
  });

  test("a suppressed tooltip leaves the button natively disabled", () => {
    const markup = renderToStaticMarkup(
      <Button disabled tooltip={false}>
        Approve
      </Button>,
    );

    expect(isNativelyDisabled(markup)).toBe(true);
    expect(isAccessiblyDisabled(markup)).toBe(false);
  });

  test("loading disables the same way", () => {
    const markup = renderToStaticMarkup(
      <Button loading tooltip="Saving">
        Save
      </Button>,
    );

    expect(isAccessiblyDisabled(markup)).toBe(true);
    expect(isNativelyDisabled(markup)).toBe(false);
  });

  test("an enabled button is disabled by neither mechanism", () => {
    const markup = renderToStaticMarkup(<Button tooltip="Save">Save</Button>);

    expect(isNativelyDisabled(markup)).toBe(false);
    expect(isAccessiblyDisabled(markup)).toBe(false);
  });
});
