import { renderToStaticMarkup } from "react-dom/server";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, jest, test } from "bun:test";

import {
  COPIED_RESET_MS,
  CopyButton,
  useCopiedFeedback,
  useCopyConfirmation,
} from "./copy-button";

GlobalRegistrator.register({ url: "https://example.test" });
const { act, cleanup, renderHook } = await import("@testing-library/react");

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});
afterAll(async () => GlobalRegistrator.unregister());

const copy = async () => await Promise.resolve(true);

describe("CopyButton", () => {
  test("shows the copy label and keeps the confirmation hidden until a copy", () => {
    const markup = renderToStaticMarkup(
      <CopyButton copiedLabel="Copied" label="Copy" onCopy={copy} />,
    );

    expect(markup).toContain('<span aria-hidden="false" class="');
    expect(markup).toMatch(/aria-hidden="false"[^>]*>Copy</u);
    expect(markup).toMatch(/aria-hidden="true"[^>]*>Copied</u);
    expect(markup).not.toContain("data-copied");
  });

  test("names an icon-only button by its label", () => {
    const markup = renderToStaticMarkup(
      <CopyButton copiedLabel="Copied" iconOnly label="Copy" onCopy={copy} />,
    );

    expect(markup).toContain('aria-label="Copy"');
    expect(markup).not.toMatch(/>Copy</u);
  });
  test("keeps caller label styling on shared feedback", () => {
    const markup = renderToStaticMarkup(
      <CopyButton
        copiedLabel="Copied"
        label="Copy"
        labelClassName="hidden sm:grid"
        onCopy={copy}
      />,
    );
    expect(markup).toContain('class="hidden sm:grid"');
  });
});

describe("copied feedback", () => {
  test("confirms, resets, and restarts the reset timer", async () => {
    jest.useFakeTimers();
    const hook = renderHook(() => useCopiedFeedback());

    act(() => hook.result.current.confirm());
    expect(hook.result.current.copied).toBe(true);

    await act(() => jest.advanceTimersByTime(COPIED_RESET_MS - 1));
    act(() => hook.result.current.confirm());
    await act(() => jest.advanceTimersByTime(COPIED_RESET_MS - 1));
    expect(hook.result.current.copied).toBe(true);

    await act(() => jest.advanceTimersByTime(1));
    expect(hook.result.current.copied).toBe(false);
  });
  test("the callback entry point confirms only successful copies", async () => {
    let succeeds = false;
    const hook = renderHook(() => useCopyConfirmation(async () => succeeds));
    await act(async () => await hook.result.current.copy());
    expect(hook.result.current.copied).toBe(false);
    succeeds = true;
    await act(async () => await hook.result.current.copy());
    expect(hook.result.current.copied).toBe(true);
  });
});
