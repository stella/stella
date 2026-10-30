import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, expectTypeOf, test } from "bun:test";

import type { ConversionRefusal } from "@stll/api-contract/conversion-refusal";
import type { FileConversionRefusal } from "@stll/workspace-ui/types";

import type { FileTab } from "@/components/inspector/inspector-tabs-store";
import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render, screen } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ConversionRefusalFallback } =
  await import("./inspector-pdf-error-fallback");
const { getFileTabEntityState } = await import("./use-file-tab-entity");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

const mount = (refusal: ConversionRefusal) => {
  render(
    <IntlProvider locale="en" messages={messages}>
      <ConversionRefusalFallback refusal={refusal} />
    </IntlProvider>,
  );
};

test("shows the named document field conversion refusal", () => {
  mount({ kind: "unsupported_field", fieldType: "INCLUDEPICTURE" });

  expect(
    screen.getByText(
      "This document contains INCLUDEPICTURE, which can't be converted.",
    ),
  ).toBeTruthy();
});

test("shows the legacy format and replacement extension", () => {
  mount({ kind: "legacy_format", replacementExtension: ".xlsx" });

  expect(
    screen.getByText(
      "This is a legacy Excel file. Re-save it as .xlsx to convert it.",
    ),
  ).toBeTruthy();
});

test("shows the document reference conversion refusal", () => {
  mount({
    kind: "unsupported_reference",
    format: "text/html",
    element: "x-thing",
    attribute: "src",
  });

  expect(
    screen.getByText(
      "This document refers to an external resource in x-thing src, so it can't be converted.",
    ),
  ).toBeTruthy();
});

test("shows the document encoding conversion refusal", () => {
  mount({ kind: "unsupported_encoding", encoding: "windows-1252" });

  expect(
    screen.getByText(
      "This document uses the unsupported windows-1252 encoding, so it can't be converted.",
    ),
  ).toBeTruthy();
});

test("shows a document reference refusal from file data", () => {
  const tab: FileTab = {
    type: "pdf",
    id: "field-1",
    entityId: "entity-1",
    label: "Document",
    fileName: "document.html",
    pdfFileId: null,
    workspaceId: "workspace-1",
  };
  const state = getFileTabEntityState({
    entityData: {
      fields: [
        {
          id: tab.id,
          content: {
            type: "file",
            version: 1,
            id: "file-1",
            fileName: tab.fileName,
            mimeType: "text/html",
            sizeBytes: 1,
            encrypted: false,
            sha256Hex: "00",
            pdfFileId: null,
            pdfDerivative: {
              status: "failed",
              conversionRefusal: {
                kind: "unsupported_reference",
                format: "text/html",
                element: "style",
                attribute: "text",
              },
            },
          },
        },
      ],
    },
    entityQueryError: false,
    needsPropertyResolution: false,
    tab,
  });

  expect(state.conversionRefusal).toBeDefined();
  if (state.conversionRefusal !== undefined) {
    mount(state.conversionRefusal);
  }
  expect(
    screen.getByText(
      "This document refers to an external resource in style text, so it can't be converted.",
    ),
  ).toBeTruthy();
});

test("the published file refusal type matches the API refusal", () => {
  expectTypeOf<FileConversionRefusal>().toEqualTypeOf<ConversionRefusal>();
});
