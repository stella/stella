import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";

import { ACTION_ADMISSION_CODES } from "@stll/api-contract/action-admission";
import { stellaToast } from "@stll/ui/toast";

import { toAPIError } from "@/lib/errors/api";
import { unregisterDomEnvironment } from "@/test-dom-environment";

import { ReaderAnswerFailure } from "./reader-answers.logic";

GlobalRegistrator.register();
const { cleanup, render, waitFor } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const messages = (await import("@/i18n/langs/en.json")).default;
const { ReaderStatusNotices } = await import("./decision-workspace");

afterEach(() => {
  cleanup();
  mock.restore();
});
afterAll(unregisterDomEnvironment);

const renderFailure = (error: unknown) =>
  render(
    <IntlProvider locale="en" messages={messages}>
      <ReaderStatusNotices
        answerFailures={[error]}
        foreignDecisionError={null}
        isCreatingAnswer={false}
        paragraphLanding={{ type: "invalid" }}
      />
    </IntlProvider>,
  );

test.each([
  {
    name: "4xx with a code",
    error: toAPIError({
      status: 400,
      value: { code: "validation", message: "Private server detail" },
    }),
    expected: messages.errors.api.validation,
  },
  {
    name: "4xx without a code",
    error: toAPIError({
      status: 400,
      value: { message: "Selection does not match the decision paragraph" },
    }),
    expected: messages.errors.api.badRequest,
  },
  {
    name: "5xx",
    error: toAPIError({ status: 503, value: { message: "Private outage" } }),
    expected: messages.readerAnswers.modelError,
  },
  {
    name: "network abort",
    error: new DOMException("Connection interrupted", "AbortError"),
    expected: messages.readerAnswers.networkError,
  },
  {
    name: "timeout",
    error: new DOMException("Deadline elapsed", "TimeoutError"),
    expected: messages.readerAnswers.timeoutError,
  },
])(
  "$name produces one owner notice and no raw alert",
  async ({ error, expected }) => {
    const add = spyOn(stellaToast, "add").mockReturnValue("reader-failure");
    const view = renderFailure(error);
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls.at(0)?.at(0)).toMatchObject({
      title: expected,
      type: "error",
    });
    expect(view.queryByRole("alert")).toBeNull();
    add.mockRestore();
  },
);

test("budget failure produces one owner notice and no raw alert", async () => {
  const add = spyOn(stellaToast, "add").mockReturnValue("reader-budget");
  const view = renderFailure(
    new ReaderAnswerFailure({
      kind: "model",
      code: ACTION_ADMISSION_CODES.periodExhausted,
      message: "Budget exhausted",
    }),
  );
  await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
  expect(add.mock.calls.at(0)?.at(0)).toMatchObject({
    id: ACTION_ADMISSION_CODES.periodExhausted,
    type: "info",
  });
  expect(view.queryByRole("alert")).toBeNull();
  add.mockRestore();
});
