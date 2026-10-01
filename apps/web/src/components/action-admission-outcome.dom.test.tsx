import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
} from "@stll/api-contract/action-admission";

import arabicMessages from "@/i18n/langs/ar.json";
import englishMessages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { act } = await import("react");
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { createTranslator } = await import("use-intl/core");
const { actionAdmissionOutcome } =
  await import("@/lib/errors/action-admission");
const { stellaToast } = await import("@stll/ui/toast");
const { ActionAdmissionOutcome, notifyActionAdmissionRefusal } =
  await import("./action-admission-outcome");
const { notifyUserError } = await import("@/lib/errors/user-toast");
const { toAPIError } = await import("@/lib/errors/api");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  });
  await GlobalRegistrator.unregister();
});

test("every refusal renders a calm localized outcome with only the permitted recovery action", () => {
  for (const { locale, messages, dir } of [
    { locale: "en", messages: englishMessages, dir: "ltr" },
    { locale: "ar", messages: arabicMessages, dir: "rtl" },
  ]) {
    for (const [code, refusal] of Object.entries(ACTION_ADMISSION_REFUSALS)) {
      let retries = 0;
      const error = toAPIError({
        status: refusal.status,
        value: {
          code,
          message: "Hidden details",
          contactUrl: "https://example.test/help",
        },
      });
      const view = render(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <div dir={dir}>
            <ActionAdmissionOutcome
              error={error}
              onRetry={() => {
                retries += 1;
              }}
            />
          </div>
        </IntlProvider>,
      );
      const outcome = actionAdmissionOutcome(error);
      expect(outcome).toBeDefined();
      if (outcome) {
        expect(view.getByRole("status").textContent).toContain(
          createTranslator({ locale, messages })(outcome.messageKey),
        );
      }
      expect(view.getByRole("status").textContent).not.toContain(
        "Hidden details",
      );
      const contact = view.queryByRole("link", {
        name: messages.errors.actionAdmission.contact,
      });
      if (
        code === ACTION_ADMISSION_CODES.periodExhausted ||
        code === ACTION_ADMISSION_CODES.notEnabled
      ) {
        expect(contact?.getAttribute("href")).toBe("https://example.test/help");
      } else {
        expect(contact).toBeNull();
      }
      const retry = view.queryByRole("button", {
        name: messages.common.tryAgain,
      });
      expect(retry !== null).toBe(refusal.retryable);
      if (retry) {
        fireEvent.click(retry);
        expect(retries).toBe(1);
      }
      view.unmount();
    }
  }
});

test("unset contact configuration renders no invented contact link", () => {
  const error = toAPIError({
    status: 403,
    value: { code: "action_not_enabled", message: "Refused" },
  });
  const view = render(
    <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
      <ActionAdmissionOutcome error={error} />
    </IntlProvider>,
  );
  expect(view.getByRole("status").textContent).toContain(
    englishMessages.errors.actionAdmission.notEnabled,
  );
  expect(view.queryByRole("link")).toBeNull();
});

test("refusal toasts use a calm tone while unrelated errors produce no toast", () => {
  const add = spyOn(stellaToast, "add").mockReturnValue("action-refusal-toast");
  try {
    const error = toAPIError({
      status: 403,
      value: {
        code: "action_not_enabled",
        message: "Refused",
        contactUrl: "https://example.test/help",
      },
    });
    expect(notifyActionAdmissionRefusal(error)).toBe(true);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "action_not_enabled",
        type: "info",
        title: englishMessages.errors.actionAdmission.notEnabled,
      }),
    );
    expect(notifyActionAdmissionRefusal(new Error("Unrelated failure"))).toBe(
      false,
    );
    expect(add).toHaveBeenCalledTimes(1);
  } finally {
    add.mockRestore();
  }
});

test("generic error toasts defer refusals to the response observer", () => {
  const add = spyOn(stellaToast, "add").mockReturnValue("generic-error-toast");
  try {
    for (const [code, refusal] of Object.entries(ACTION_ADMISSION_REFUSALS)) {
      const error = toAPIError({
        status: refusal.status,
        value: { code, message: "Refused" },
      });
      expect(notifyUserError(error, "Generic failure")).toBe(false);
    }
    expect(add).not.toHaveBeenCalled();
    expect(
      notifyUserError(new Error("Unexpected failure"), "Generic failure"),
    ).toBe(true);
    expect(add).toHaveBeenCalledWith({
      title: "Generic failure",
      type: "error",
    });
  } finally {
    add.mockRestore();
  }
});

test("repeated refusal notifications retain one stable toast identity per code", () => {
  const add = spyOn(stellaToast, "add").mockReturnValue("refusal-toast");
  try {
    for (const [code, refusal] of Object.entries(ACTION_ADMISSION_REFUSALS)) {
      const error = toAPIError({
        status: refusal.status,
        value: { code, message: "Refused" },
      });
      notifyActionAdmissionRefusal(error);
      notifyActionAdmissionRefusal(error);
      expect(add.mock.calls.at(-1)?.at(0)?.id).toBe(code);
      expect(add.mock.calls.at(-2)?.at(0)?.id).toBe(code);
    }
  } finally {
    add.mockRestore();
  }
});
