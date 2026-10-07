import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000/review" });
const { act } = await import("@testing-library/react");
const { renderToString } = await import("react-dom/server");
const { hydrateRoot } = await import("react-dom/client");
const { browserStorage } = await import("@/lib/account/browser-storage");
const { userStorageKey } = await import("@/lib/account/user-scoped-storage");
const { REVIEW_START_MODE, reviewStartModeStorageKey } =
  await import("./document-review-basis.logic");
const { useReviewStartMode } = await import("./use-review-start-mode");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const ReviewMode = () => {
  const { mode } = useReviewStartMode("document", "file");
  return <span>{mode}</span>;
};

test("review hydration starts with the default and restores the saved mode", async () => {
  const storage =
    browserStorage("local") ?? panic("Test requires browser storage");
  const key = userStorageKey(reviewStartModeStorageKey("document", "file"));
  storage.removeItem(key);
  const markup = renderToString(<ReviewMode />);
  expect(markup).toContain(REVIEW_START_MODE.immediate);
  expect(markup).not.toContain(REVIEW_START_MODE.confirmFirst);
  const container = document.createElement("div");
  // safe-html: react-dom/server renderToString output from ReviewMode's fixed span and review-mode literals.
  container.innerHTML = markup;
  document.body.append(container);
  storage.setItem(key, REVIEW_START_MODE.confirmFirst);
  const recoverableErrors: unknown[] = [];
  const root = hydrateRoot(container, <ReviewMode />, {
    onRecoverableError: (error) => {
      recoverableErrors.push(error);
    },
  });
  try {
    await act(async () => {
      await Promise.resolve();
    });
    expect(recoverableErrors).toEqual([]);
    expect(container.textContent).toBe(REVIEW_START_MODE.confirmFirst);
  } finally {
    act(() => {
      root.unmount();
    });
    container.remove();
    storage.removeItem(key);
  }
});

test("review server rendering uses its default with browser preferences present", () => {
  const storage =
    browserStorage("local") ?? panic("Test requires browser storage");
  const key = userStorageKey(reviewStartModeStorageKey("document", "file"));
  storage.setItem(key, REVIEW_START_MODE.confirmFirst);
  try {
    expect(renderToString(<ReviewMode />)).toContain(
      REVIEW_START_MODE.immediate,
    );
  } finally {
    storage.removeItem(key);
  }
});
