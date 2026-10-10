import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "bun:test";

import { appLocale } from "../shared/locale";
import type { createDocumentUploadRuntime } from "./runtime";
import { DocumentUpload } from "./view";

test("document upload requires a resolved target and announces upload errors", () => {
  let uploads = 0;
  let snapshot: ReturnType<
    ReturnType<typeof createDocumentUploadRuntime>["getSnapshot"]
  >;
  const runtime = {
    detached: () => undefined,
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    selectFile: () => undefined,
    upload: async () => {
      uploads += 1;
    },
    connect: async () => undefined,
  } satisfies ReturnType<typeof createDocumentUploadRuntime>;
  snapshot = {
    file: null,
    uploadTarget: null,
    uploadPhase: "idle",
    targetLabel: "Dokument 42",
    message: "",
    status: "idle",
    locale: appLocale("cs-CZ"),
  };
  const view = render(<DocumentUpload runtime={runtime} />);
  expect(
    screen.getByRole("heading", { name: "Nahrát novou verzi" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Soubor Vybrat soubor" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Nahrát verzi" })
      .hasAttribute("disabled"),
  ).toBe(true);
  snapshot = {
    ...snapshot,
    file: new File(["version"], "návrh.docx"),
    uploadTarget: { entityId: "42", workspaceId: "matter" },
  };
  view.rerender(<DocumentUpload runtime={runtime} />);
  expect(screen.getByText("návrh.docx").tagName).toBe("BDI");
  fireEvent.click(screen.getByRole("button", { name: "Nahrát verzi" }));
  expect(uploads).toBe(1);
  snapshot = { ...snapshot, message: "Nahrání se nezdařilo", status: "error" };
  view.rerender(<DocumentUpload runtime={runtime} />);
  expect(screen.getByRole("status").textContent).toBe("Nahrání se nezdařilo");
});
