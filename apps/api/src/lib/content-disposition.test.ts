import { describe, expect, test } from "bun:test";

import { contentDisposition } from "./content-disposition";

describe("contentDisposition", () => {
  test("uses simple filename form for safe ASCII names", () => {
    expect(contentDisposition("report.pdf")).toBe(
      'attachment; filename="report.pdf"',
    );
  });

  test("uses fallback and UTF-8 filename* for non-ASCII names", () => {
    expect(contentDisposition("nález ÚS.pdf")).toBe(
      "attachment; filename=\"n_lez _S.pdf\"; filename*=UTF-8''n%C3%A1lez%20%C3%9AS.pdf",
    );
  });

  test("sanitizes quotes and backslashes in the ASCII fallback", () => {
    expect(contentDisposition('report\\"final".pdf')).toBe(
      "attachment; filename=\"report__final_.pdf\"; filename*=UTF-8''report%5C%22final%22.pdf",
    );
  });
});
