import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
} from "@stll/api-contract/action-admission";
import { sleep } from "@stll/concurrency/sleep";

import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";

import type { ReportExportRequest } from "./export-report-dialog.logic";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { act } = await import("react");
const { cleanup, fireEvent, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { toAPIError } = await import("@/lib/errors/api");
const { ReportExportRefusal } = await import("./report-export-refusal");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await act(async () => {
    await sleep(50);
  });
  await GlobalRegistrator.unregister();
});

test("only a refused AI export offers an explicit fallback preserving request fields", () => {
  const templateRefs = [
    { type: "builtin", key: "report-example" },
    { type: "stored", templateId: toSafeId<"template">("template-example") },
  ] as const satisfies readonly ReportExportRequest["templateRef"][];
  for (const [code, refusal] of Object.entries(ACTION_ADMISSION_REFUSALS)) {
    for (const aiNarrative of [true, false, undefined]) {
      for (const templateRef of templateRefs) {
        for (const mode of ["download", "workspace"] as const) {
          for (const format of ["docx", "pdf"] as const) {
            const request = {
              templateRef,
              viewId: toSafeId<"workspaceView">("view-example"),
              mode,
              format,
              ...(aiNarrative === undefined ? {} : { aiNarrative }),
            } satisfies ReportExportRequest;
            const submitted: ReportExportRequest[] = [];
            const view = render(
              <IntlProvider locale="en" messages={messages} timeZone="UTC">
                <ReportExportRefusal
                  request={request}
                  error={toAPIError({
                    status: refusal.status,
                    value: { code, message: "Hidden details" },
                  })}
                  onSubmit={(value) => {
                    submitted.push(value);
                  }}
                />
              </IntlProvider>,
            );
            expect(view.getByRole("status")).toBeDefined();
            expect(submitted).toEqual([]);
            const fallback = view.queryByRole("button", {
              name: messages.workspaces.views.reportExport.withoutAiSummaries,
            });
            expect(fallback !== null).toBe(
              code === ACTION_ADMISSION_CODES.notEnabled &&
                aiNarrative === true,
            );
            if (fallback) {
              fireEvent.click(fallback);
              expect(submitted).toEqual([{ ...request, aiNarrative: false }]);
              expect(request.aiNarrative).toBe(true);
            }
            view.unmount();
          }
        }
      }
    }
  }
});
