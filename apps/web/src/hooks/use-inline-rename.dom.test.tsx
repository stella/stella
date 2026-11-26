import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/" });

const { act, cleanup, renderHook } = await import("@testing-library/react");
const { useInlineRename } = await import("./use-inline-rename");

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

type Options = Parameters<typeof useInlineRename>[0];

/** A rename of "Contract" that left the page with `draft` typed in. */
const leaveWithDraft = (draft: string, options: Partial<Options> = {}) => {
  const onCommit = mock<Options["onCommit"]>(() => undefined);
  const { result, unmount } = renderHook(() =>
    useInlineRename({
      initial: "Contract",
      onCommit,
      commitOnUnmount: true,
      ...options,
    }),
  );
  act(() => {
    result.current.startEditing();
  });
  act(() => {
    result.current.setDraft(draft);
  });
  unmount();
  return onCommit;
};

describe("an inline rename whose editor leaves the page", () => {
  test("sends the trimmed draft a commit would send", () => {
    const onCommit = leaveWithDraft("  Lease  ");
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0]).toBe("Lease");
  });

  test("sends nothing for an unchanged, empty or invalid draft", () => {
    expect(leaveWithDraft(" Contract ")).not.toHaveBeenCalled();
    expect(leaveWithDraft("   ")).not.toHaveBeenCalled();
    expect(
      leaveWithDraft("Lease", { validate: () => "Taken" }),
    ).not.toHaveBeenCalled();
  });

  test("sends nothing unless asked to", () => {
    expect(
      leaveWithDraft("Lease", { commitOnUnmount: false }),
    ).not.toHaveBeenCalled();
  });
});

describe("committing an inline rename", () => {
  test("closes the editor, and a rejected name reopens it with the error", async () => {
    let reject: ((message: string) => void) | undefined;
    const { result } = renderHook(() =>
      useInlineRename({
        initial: "Contract",
        onCommit: (_value, { setError }) => {
          reject = setError;
        },
      }),
    );
    act(() => {
      result.current.startEditing();
    });
    act(() => {
      result.current.setDraft("Lease");
    });
    await act(async () => {
      await result.current.commit();
    });
    expect(result.current.state).toEqual({ mode: "view" });

    act(() => {
      reject?.("Name taken");
    });
    expect(result.current.state).toEqual({
      mode: "edit",
      draft: "Lease",
      error: "Name taken",
    });
  });

  test("keeps an invalid draft open with the validation error", async () => {
    const onCommit = mock(() => undefined);
    const { result } = renderHook(() =>
      useInlineRename({
        initial: "Contract",
        onCommit,
        validate: (value) => (value.length < 3 ? "Too short" : null),
      }),
    );
    act(() => {
      result.current.startEditing();
    });
    act(() => {
      result.current.setDraft(" Le ");
    });
    await act(async () => {
      await result.current.commit();
    });
    expect(result.current.state).toEqual({
      mode: "edit",
      draft: " Le ",
      error: "Too short",
    });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
