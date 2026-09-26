import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { resolveStampRequest } from "@/api/lib/pdf-signing/handoff-preflight";
import type { StampRequest } from "@/api/lib/pdf-signing/handoff-preflight";

const onePage = async () => {
  const created = PDF.create();
  created.addPage({ width: 595, height: 842 });
  return await PDF.load(await created.save());
};

const request = (overrides: Partial<StampRequest> = {}): StampRequest => ({
  box: { x: 0.6, y: 0.85, width: 0.34, height: 0.07 },
  direction: "ltr",
  labels: {
    date: "Date",
    location: "Location",
    reason: "Reason",
    signedBy: "Digitally signed by",
  },
  pageIndex: 0,
  timeZone: "Europe/Prague",
  ...overrides,
});

const codeOf = (result: ReturnType<typeof resolveStampRequest>) =>
  Result.isError(result) ? result.error.code : null;

describe("resolving a requested stamp", () => {
  test("stores the placement in user space with sanitized labels", async () => {
    const resolved = resolveStampRequest(
      await onePage(),
      request({
        labels: {
          date: "Date\n/Evil (x)",
          location: "",
          reason: "Reason",
          signedBy: "Signed\u0000 by",
        },
      }),
    );

    expect(Result.isOk(resolved)).toBe(true);
    if (!Result.isOk(resolved)) {
      return;
    }
    expect(resolved.value.pageIndex).toBe(0);
    expect(resolved.value.rotation).toBe(0);
    // Line breaks and NULs cannot split a stamp line or a dictionary entry.
    expect(resolved.value.labels.date).toBe("Date /Evil (x)");
    expect(resolved.value.labels.signedBy).toBe("Signed  by");
    const [llx, lly, urx, ury] = resolved.value.rect;
    expect(urx - llx).toBeCloseTo(0.34 * 595, 6);
    expect(ury - lly).toBeCloseTo(0.07 * 842, 6);
  });

  test("refuses an unknown time zone and a misplaced box with stable codes", async () => {
    const pdf = await onePage();

    expect(
      codeOf(resolveStampRequest(pdf, request({ timeZone: "Mars/Olympus" }))),
    ).toBe("pdf_signing_stamp_time_zone");
    expect(
      codeOf(
        resolveStampRequest(
          pdf,
          request({ box: { x: 0.9, y: 0.9, width: 0.34, height: 0.07 } }),
        ),
      ),
    ).toBe("pdf_signing_stamp_off_page");
    expect(codeOf(resolveStampRequest(pdf, request({ pageIndex: 2 })))).toBe(
      "pdf_signing_stamp_page_not_found",
    );
  });
});
