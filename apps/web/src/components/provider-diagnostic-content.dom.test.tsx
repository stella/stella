import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import {
  PROVIDER_SETUP_ERROR_CATALOGUE,
  PROVIDER_SETUP_ERROR_CODE,
} from "@stll/api-contract/provider-setup";
import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register();
const { act, cleanup, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ProviderSetupGuidanceNotice } =
  await import("./provider-diagnostic-content");
const { providerSetupGuidance } =
  await import("@/lib/errors/provider-setup-guidance");

const { ToastProvider } = await import("@stll/ui/toast");
const { notifyUserError } = await import("@/lib/errors/user-toast");
const { toAPIError } = await import("@/lib/errors/api");

const messagesByLocale = { en, ar };
// The provider's own wording: untranslated and naming request internals.
const reason = "messages.0: user messages must have non-empty content";

afterEach(async () => {
  await act(async () => cleanup());
  mock.restore();
});
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

for (const [locale, messages] of Object.entries(messagesByLocale)) {
  for (const code of Object.values(PROVIDER_SETUP_ERROR_CODE)) {
    test(`${locale} setup code ${code} shows its translated fix and console link`, () => {
      render(
        <IntlProvider locale={locale} messages={messages}>
          <ProviderSetupGuidanceNotice code={code} />
        </IntlProvider>,
      );
      const guidance =
        providerSetupGuidance(code) ?? panic("Missing provider guidance");
      expect(document.body.textContent).toContain(
        messages.organization.aiConfig[guidance.guidance],
      );
      expect(screen.getByRole("link").getAttribute("href")).toBe(
        PROVIDER_SETUP_ERROR_CATALOGUE[code].url,
      );
    });
  }
}

test("a refusal without a setup code adds nothing", () => {
  const { container } = render(
    <IntlProvider locale="en" messages={en}>
      <ProviderSetupGuidanceNotice code={null} />
    </IntlProvider>,
  );
  expect(container.textContent).toBe("");
});

test.each([PROVIDER_SETUP_ERROR_CODE.openaiInsufficientQuota, null])(
  "a provider failure toast (setup code %p) shows the typed message, never the provider's wording",
  async (code) => {
    const diagnostic = {
      provider: "openai",
      code,
      message: reason,
    } satisfies ProviderDiagnostic;
    const error = toAPIError({
      status: 500,
      value: {
        message: "Provider operation failed",
        providerDiagnostic: diagnostic,
      },
    });
    render(
      <IntlProvider locale="en" messages={en}>
        <ToastProvider />
      </IntlProvider>,
    );
    await act(async () => {
      notifyUserError(error, "Generic failure fallback");
    });
    // An uncoded 500 keeps the surface's own message as the toast title.
    await waitFor(() =>
      expect(document.body.textContent).toContain("Generic failure fallback"),
    );
    expect(document.body.textContent).not.toContain(reason);
    expect(screen.queryByRole("button", { name: en.common.copy })).toBeNull();
    if (code === null) {
      expect(screen.queryByRole("link")).toBeNull();
      return;
    }
    expect(screen.getByRole("link").getAttribute("href")).toBe(
      PROVIDER_SETUP_ERROR_CATALOGUE[code].url,
    );
  },
);
