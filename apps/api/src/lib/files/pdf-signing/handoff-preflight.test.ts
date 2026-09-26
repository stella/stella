import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  drawableStamp,
  resolveStampRequest,
} from "@/api/lib/files/pdf-signing/handoff-preflight";
import type { StampRequest } from "@/api/lib/files/pdf-signing/handoff-preflight";
import { ENGLISH_STAMP_LABELS } from "@/api/lib/files/pdf-signing/stamp-text";

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

describe("text a stamp can draw", () => {
  const placedStamp = async (labels: StampRequest["labels"]) => {
    const resolved = resolveStampRequest(
      await onePage(),
      request({ direction: "rtl", labels }),
    );
    if (!Result.isOk(resolved)) {
      throw new Error("fixture stamp did not resolve");
    }
    return resolved.value;
  };

  test("keeps the signer's labels when they can be drawn", async () => {
    const stamp = await placedStamp({
      date: "Datum",
      location: "Místo",
      reason: "Důvod",
      signedBy: "Digitálně podepsal",
    });

    const drawn = await drawableStamp({ location: null, reason: null, stamp });
    expect(Result.isOk(drawn) && drawn.value.labels.signedBy).toBe(
      "Digitálně podepsal",
    );
  });

  test("falls back to English labels for a script it cannot shape", async () => {
    const stamp = await placedStamp({
      date: "التاريخ",
      location: "المكان",
      reason: "السبب",
      signedBy: "موقّع رقميًا من",
    });

    const drawn = await drawableStamp({ location: null, reason: null, stamp });
    expect(Result.isOk(drawn) && drawn.value.labels).toEqual(
      ENGLISH_STAMP_LABELS,
    );
    expect(Result.isOk(drawn) && drawn.value.direction).toBe("ltr");
  });

  test("refuses a reason or location it would draw wrongly or not at all", async () => {
    const stamp = await placedStamp(ENGLISH_STAMP_LABELS);

    for (const text of ["عقد البيع", "契約書", "ข้อตกลง"]) {
      const drawn = await drawableStamp({
        location: null,
        reason: text,
        stamp,
      });
      expect(Result.isError(drawn) && drawn.error.code).toBe(
        "pdf_signing_stamp_unrenderable",
      );
    }
    const latin = await drawableStamp({
      location: "Łódź",
      reason: null,
      stamp,
    });
    expect(Result.isOk(latin)).toBe(true);
  });
});
