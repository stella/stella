import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "bun:test";

import { appLocale } from "../shared/locale";
import type { createFileComparisonRuntime } from "./runtime";
import { FileComparison } from "./view";

test("comparison labels both files and enables the handoff only when ready", () => {
  let uploads = 0;
  let snapshot: ReturnType<
    ReturnType<typeof createFileComparisonRuntime>["getSnapshot"]
  > = {
    base: null,
    target: null,
    uploadPhase: "idle",
    message: "",
    status: "idle",
    locale: appLocale("cs"),
  };
  const runtime = {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    selectBase: () => undefined,
    selectTarget: () => undefined,
    upload: async () => {
      uploads += 1;
    },
    connect: async () => undefined,
  } satisfies ReturnType<typeof createFileComparisonRuntime>;
  const view = render(<FileComparison runtime={runtime} />);
  expect(
    screen.getByRole("button", { name: "Původní Vybrat soubor" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Upravený Vybrat soubor" }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Nahrát pro porovnání" })
      .hasAttribute("disabled"),
  ).toBe(true);
  snapshot = {
    ...snapshot,
    base: new File(["original"], "původní.docx"),
    target: new File(["revised"], "upravený.docx"),
  };
  view.rerender(<FileComparison runtime={runtime} />);
  fireEvent.click(screen.getByRole("button", { name: "Nahrát pro porovnání" }));
  expect(uploads).toBe(1);
  snapshot = {
    ...snapshot,
    locale: appLocale("ar"),
    message: "تم التحميل.",
    status: "success",
  };
  view.rerender(<FileComparison runtime={runtime} />);
  expect(screen.getByRole("heading", { name: "مقارنة ملفين" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("تم التحميل.");
  expect(screen.getByText("původní.docx").tagName).toBe("BDI");
});
