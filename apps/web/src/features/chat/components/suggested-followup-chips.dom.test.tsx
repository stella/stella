import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register();
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { default: messages } = await import("@/i18n/langs/en.json");
const { SuggestedFollowupChips } = await import("./suggested-followup-chips");

afterEach(cleanup);
afterAll(async () => unregisterDomEnvironment());

test("wraps follow-ups without horizontal overflow and preserves full labels", () => {
  const longLabel = "A follow-up prompt long enough to truncate";
  const view = render(
    <IntlProvider locale="en" messages={messages}>
      <SuggestedFollowupChips
        prompts={[longLabel, "Short"]}
        onSelect={() => undefined}
      />
    </IntlProvider>,
  );
  const group = view.getByRole("group");
  expect(group.className).toContain("flex-wrap");
  expect(group.className).not.toContain("overflow-x");
  expect(view.getByText(longLabel).title).toBe(longLabel);
});
