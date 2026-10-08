import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

GlobalRegistrator.register();
const { act, cleanup, render, screen, waitFor } =
  await import("@testing-library/react");
const { ToastProvider, stellaToast } = await import("@stll/ui/toast");
const { createErrorToasts } =
  await import("../../../../../packages/ui/src/components/toast.fixture");

const providerReason =
  "Anthropic: This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.";
const detail = `Request rejected.\n${"The complete provider response must remain available. ".repeat(
  12,
)}`;

afterEach(async () => {
  await act(async () => {
    stellaToast.dismiss();
    cleanup();
  });
});
afterAll(() => GlobalRegistrator.unregister());

for (const [entry, create] of Object.entries(createErrorToasts(detail))) {
  test(`error toast via ${entry} exposes the full wrapping title and description`, async () => {
    const reason = `${entry}: ${providerReason}`;
    render(<ToastProvider />);
    await act(async () => {
      if (entry === "promise") {
        const rejection = await rejectionOf(Promise.resolve(create(reason)));
        expect(rejection).toMatchObject({ message: reason });
        return;
      }
      await create(reason);
    });
    await waitFor(() => expect(screen.getByText(reason)).toBeTruthy());
    const title = screen.getByText(reason);
    const description = title.parentElement?.querySelector(
      '[data-slot="toast-description"]',
    );
    expect(title.textContent).toBe(reason);
    expect(description?.textContent).toBe(detail);
    for (const surface of [title, description]) {
      expect(surface?.classList.contains("whitespace-pre-wrap")).toBe(true);
      expect(surface?.classList.contains("wrap-anywhere")).toBe(true);
      expect(surface?.className).not.toMatch(
        /\b(?:truncate|line-clamp-\d+|text-ellipsis|whitespace-nowrap)\b/u,
      );
    }
  });
}
