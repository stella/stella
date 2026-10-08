import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
} from "@stll/api-contract/action-admission";
import { sleep } from "@stll/concurrency/sleep";

import arabicMessages from "@/i18n/langs/ar.json";
import englishMessages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { act } = await import("react");
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { createTranslator } = await import("use-intl/core");
const { actionAdmissionOutcome } =
  await import("@/lib/errors/action-admission");
const { stellaToast, ToastProvider } = await import("@stll/ui/toast");
const { ActionAdmissionOutcome, notifyActionAdmissionRefusal } =
  await import("./action-admission-outcome");
const { notifyAuthClientError, notifyUserError } =
  await import("@/lib/errors/user-toast");
const { toAPIError } = await import("@/lib/errors/api");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await act(async () => {
    await sleep(50);
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

test("unobserved refusals emit localized notices instead of generic error toasts", () => {
  const add = spyOn(stellaToast, "add").mockReturnValue("generic-error-toast");
  try {
    for (const [code, refusal] of Object.entries(ACTION_ADMISSION_REFUSALS)) {
      const error = toAPIError({
        status: refusal.status,
        value: { code, message: "Refused" },
      });
      expect(notifyUserError(error, "Generic failure")).toBe(false);
    }
    expect(add).toHaveBeenCalledTimes(
      Object.keys(ACTION_ADMISSION_REFUSALS).length,
    );
    for (const [index, [code]] of Object.entries(
      ACTION_ADMISSION_REFUSALS,
    ).entries()) {
      expect(add.mock.calls.at(index)?.at(0)).toEqual(
        expect.objectContaining({ id: code, type: "info" }),
      );
    }
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

test("refused error updates close pending toasts and coalesce with the localized observer notice", () => {
  const add = spyOn(stellaToast, "add").mockReturnValue("refusal-toast");
  const update = spyOn(stellaToast, "update").mockImplementation(() => {});
  const close = spyOn(stellaToast, "close").mockImplementation(() => {});
  try {
    for (const [code, refusal] of Object.entries(ACTION_ADMISSION_REFUSALS)) {
      const error = toAPIError({
        status: refusal.status,
        value: { code, message: "Private server detail" },
      });
      // The response observer runs before the local mutation failure handler.
      expect(notifyActionAdmissionRefusal(error)).toBe(true);
      expect(
        notifyUserError(error, "Generic failure", {
          toastId: `pending-${code}`,
        }),
      ).toBe(false);
      const outcome = actionAdmissionOutcome(error);
      expect(outcome).toBeDefined();
      if (outcome) {
        expect(add.mock.calls.at(-1)?.at(0)?.title).toBe(
          createTranslator({ locale: "en", messages: englishMessages })(
            outcome.messageKey,
          ),
        );
      }
      expect(close.mock.calls.at(-1)).toEqual([`pending-${code}`]);
    }
    expect(update).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledTimes(
      2 * Object.keys(ACTION_ADMISSION_REFUSALS).length,
    );
  } finally {
    add.mockRestore();
    update.mockRestore();
    close.mockRestore();
  }
});

test("error updates preserve recovery options and hide unexpected server details", () => {
  const add = spyOn(stellaToast, "add").mockReturnValue("unexpected-toast");
  const update = spyOn(stellaToast, "update").mockImplementation(() => {});
  try {
    const retry = () => {};
    expect(
      notifyUserError(new Error("Private server detail"), "Upload failed", {
        toastId: "upload",
        description: "Try again",
        timeout: 0,
        actionProps: { children: "Retry", onClick: retry },
      }),
    ).toBe(true);
    expect(update).toHaveBeenCalledWith("upload", {
      title: "Upload failed",
      type: "error",
      description: "Try again",
      timeout: 0,
      actionProps: { children: "Retry", onClick: retry },
    });
    expect(add).not.toHaveBeenCalled();
  } finally {
    add.mockRestore();
    update.mockRestore();
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

test("observer and local failure handlers render one refusal notice", async () => {
  const view = render(<ToastProvider />);
  try {
    for (const [code, refusal] of Object.entries(ACTION_ADMISSION_REFUSALS)) {
      const error = toAPIError({
        status: refusal.status,
        value: { code, message: "Private detail" },
      });
      await act(async () => {
        notifyActionAdmissionRefusal(error);
        notifyUserError(error, "Generic failure");
      });
      const outcome = actionAdmissionOutcome(error);
      expect(outcome).toBeDefined();
      if (outcome) {
        const title = createTranslator({
          locale: "en",
          messages: englishMessages,
        })(outcome.messageKey);
        expect(view.getAllByText(title)).toHaveLength(1);
      }
    }
    expect(view.queryByText("Generic failure")).toBeNull();
    expect(view.queryByText("Private detail")).toBeNull();
  } finally {
    await act(async () => {
      stellaToast.close();
    });
  }
});

test("organization setup keeps human client reasons without exposing server failures", () => {
  const add = spyOn(stellaToast, "add");
  const fallback = "Organization setup failed";
  try {
    for (const code of [
      undefined,
      "ORGANIZATION_NAME_INVALID",
      "DISPOSABLE_EMAIL_NOT_ALLOWED",
    ]) {
      for (const status of [400, 403, 500]) {
        for (const message of [
          undefined,
          "Organization name must be shorter",
          "",
        ]) {
          add.mockClear();
          expect(
            notifyAuthClientError(
              { code, status, statusText: "Failure", message },
              fallback,
            ),
          ).toBe(true);
          expect(add).toHaveBeenCalledWith(
            expect.objectContaining({
              type: "error",
              description: status < 500 ? (message ?? fallback) : fallback,
            }),
          );
          expect(add).toHaveBeenCalledTimes(1);
        }
      }
    }
  } finally {
    add.mockRestore();
  }
});
