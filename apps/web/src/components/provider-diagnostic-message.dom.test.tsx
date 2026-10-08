import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { panic } from "better-result";
import { afterAll, afterEach, expect, spyOn, test, mock } from "bun:test";

import {
  PROVIDER_SETUP_ERROR_CATALOGUE,
  PROVIDER_SETUP_ERROR_CODE,
} from "@stll/api-contract/provider-setup";
import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";
import { sleep } from "@stll/concurrency/sleep";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";

GlobalRegistrator.register();
const { act, cleanup, fireEvent, render, screen, waitFor } =
  await import("@testing-library/react");
const { IntlProvider, createTranslator } = await import("use-intl");
const { ProviderDiagnosticMessage } =
  await import("./provider-diagnostic-message");
const { providerSetupGuidance } =
  await import("@/lib/errors/provider-setup-guidance");

const { ToastProvider } = await import("@stll/ui/toast");
const { notifyUserError } = await import("@/lib/errors/user-toast");
const { toAPIError } = await import("@/lib/errors/api");

const messagesByLocale = { en, ar };
const reason = `Workspace setup refused.\n${"Complete provider reason ".repeat(20)}END`;

afterEach(async () => {
  await act(async () => cleanup());
  mock.restore();
});
afterAll(async () => {
  cleanup();
  await act(async () => {
    await sleep(50);
  });
  await GlobalRegistrator.unregister();
});

for (const [locale, messages] of Object.entries(messagesByLocale)) {
  for (const code of Object.values(PROVIDER_SETUP_ERROR_CODE)) {
    test(`${locale} diagnostic ${code} exposes complete reason, exact fix, console link and copy`, async () => {
      const catalogue = PROVIDER_SETUP_ERROR_CATALOGUE[code];
      const diagnostic = {
        provider: catalogue.provider,
        code,
        message: reason,
      } satisfies ProviderDiagnostic;
      const copy = spyOn(navigator.clipboard, "writeText").mockResolvedValue(
        undefined,
      );
      const t = createTranslator({ locale, messages });
      render(
        <IntlProvider locale={locale} messages={messages}>
          <ProviderDiagnosticMessage diagnostic={diagnostic} />
        </IntlProvider>,
      );
      const fullMessage = `${diagnostic.provider}: ${reason}`;
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain(fullMessage);
      expect(alert.textContent).toContain(
        t(
          (providerSetupGuidance(code) ?? panic("Missing provider guidance"))
            .guidance,
        ),
      );
      expect(screen.getByRole("link").getAttribute("href")).toBe(catalogue.url);
      expect(alert.querySelector("bdi")?.textContent).toBe(diagnostic.provider);
      expect(alert.querySelector("p")?.getAttribute("dir")).toBe("auto");
      expect(alert.querySelector("p")?.className).toContain("wrap-anywhere");
      fireEvent.click(
        screen.getByRole("button", { name: messages.common.copy }),
      );
      await waitFor(() => expect(copy).toHaveBeenCalledWith(fullMessage));
      expect(
        screen.getByRole("button", { name: messages.common.copied }),
      ).toBeTruthy();
    });
  }
}

test("unknown provider errors retain full text and copy without fabricated guidance", () => {
  render(
    <IntlProvider locale="en" messages={en}>
      <ProviderDiagnosticMessage
        diagnostic={{
          provider: "custom-provider",
          code: null,
          message: reason,
        }}
      />
    </IntlProvider>,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    `custom-provider: ${reason}`,
  );
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByRole("button", { name: en.common.copy })).toBeTruthy();
});

test("runtime HTTP error notification renders diagnostic guidance instead of a generic fallback", async () => {
  const diagnostic = {
    provider: "openai",
    code: PROVIDER_SETUP_ERROR_CODE.openaiInsufficientQuota,
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
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      `openai: ${reason}`,
    ),
  );
  expect(screen.queryByText("Generic failure fallback")).toBeNull();
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    PROVIDER_SETUP_ERROR_CATALOGUE[diagnostic.code].url,
  );
  expect(screen.getByRole("button", { name: en.common.copy })).toBeTruthy();
});
