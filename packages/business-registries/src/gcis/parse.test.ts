import { describe, expect, test } from "bun:test";

import { parseCompany, parseSearchEntry } from "./parse.js";
import type { GcisRawCompany } from "./types.js";

const baseRaw: GcisRawCompany = {
  Business_Accounting_NO: "22099131",
};

describe("parseCompany", () => {
  test("maps the live TSMC payload through to the domain shape", () => {
    const company = parseCompany({
      Business_Accounting_NO: "22099131",
      Company_Status_Desc: "核准設立",
      Company_Name: "台灣積體電路製造股份有限公司",
      Capital_Stock_Amount: 280_500_000_000,
      Paid_In_Capital_Amount: 259_323_700_670,
      Responsible_Name: "魏哲家",
      Company_Location: "新竹科學園區新竹市力行六路8號",
      Register_Organization_Desc: "國家科學及技術委員會新竹科學園區管理局",
      Company_Setup_Date: "0760221",
      Change_Of_Approval_Data: "1150525",
    });
    expect(company.taxId).toBe("22099131");
    expect(company.name).toBe("台灣積體電路製造股份有限公司");
    expect(company.capitalAmount).toBe(280_500_000_000);
    expect(company.paidInCapitalAmount).toBe(259_323_700_670);
    expect(company.responsibleName).toBe("魏哲家");
    expect(company.location).toBe("新竹科學園區新竹市力行六路8號");
    // ROC 76 (民國76) → 1987-02-21. ROC 115 → 2026-05-25.
    expect(company.setupDate).toBe("1987-02-21");
    expect(company.setupDateRoc).toBe("0760221");
    expect(company.lastChangeDate).toBe("2026-05-25");
    expect(company.status).toEqual({ type: "active" });
    expect(company.statusDescription).toBe("核准設立");
    expect(company.registryUrl).toContain("22099131");
  });

  test("falls back to taxId when Company_Name is missing", () => {
    const company = parseCompany(baseRaw);
    expect(company.name).toBe("22099131");
  });

  test("treats empty-string fields as null", () => {
    const company = parseCompany({
      ...baseRaw,
      Company_Name: "Acme",
      Responsible_Name: "",
      Company_Location: "   ",
      Company_Setup_Date: "",
    });
    expect(company.responsibleName).toBeNull();
    expect(company.location).toBeNull();
    expect(company.setupDateRoc).toBeNull();
    expect(company.setupDate).toBeNull();
  });

  test("does not coerce zero capital to null", () => {
    // GCIS legitimately reports zero capital for foreign branches and
    // certain sub-entities; collapsing zero into null would lose the
    // "filed as zero" signal.
    const company = parseCompany({
      ...baseRaw,
      Company_Name: "Acme",
      Capital_Stock_Amount: 0,
      Paid_In_Capital_Amount: 0,
    });
    expect(company.capitalAmount).toBe(0);
    expect(company.paidInCapitalAmount).toBe(0);
  });
});

describe("parseStatus (via parseCompany)", () => {
  test("maps documented Company_Status codes", () => {
    expect(parseCompany({ ...baseRaw, Company_Status: "01" }).status).toEqual({
      type: "active",
    });
    expect(parseCompany({ ...baseRaw, Company_Status: "02" }).status).toEqual({
      type: "active",
    });
    expect(parseCompany({ ...baseRaw, Company_Status: "03" }).status).toEqual({
      type: "dissolved",
    });
    expect(parseCompany({ ...baseRaw, Company_Status: "05" }).status).toEqual({
      type: "dissolved",
    });
    expect(parseCompany({ ...baseRaw, Company_Status: "06" }).status).toEqual({
      type: "suspended",
    });
  });

  test("falls back to Company_Status_Desc text when no code is present", () => {
    expect(
      parseCompany({ ...baseRaw, Company_Status_Desc: "核准設立" }).status,
    ).toEqual({ type: "active" });
    expect(
      parseCompany({ ...baseRaw, Company_Status_Desc: "解散" }).status,
    ).toEqual({ type: "dissolved" });
    expect(
      parseCompany({ ...baseRaw, Company_Status_Desc: "停業" }).status,
    ).toEqual({ type: "suspended" });
  });

  test("treats unknown codes / descriptions as unknown, not active", () => {
    // Misreporting an undocumented future code as "active" would
    // tell consumers a dissolved entity is still trading. The
    // explicit `unknown` arm lets the UI render an honest badge.
    expect(parseCompany({ ...baseRaw, Company_Status: "99" }).status).toEqual({
      type: "unknown",
    });
    expect(parseCompany(baseRaw).status).toEqual({ type: "unknown" });
  });

  test("active code is overridden when a suspension window is in force", () => {
    // GCIS keeps the headline status at "01" for entities that have
    // only paused operations; surfacing that as "active" misreports
    // the running state for entities visibly in 停業.
    const company = parseCompany(
      {
        ...baseRaw,
        Company_Status: "01",
        Company_Status_Desc: "核准設立",
        Sus_Beg_Date: "1140601",
        Sus_End_Date: "1141231",
      },
      new Date("2025-06-15T00:00:00Z"),
    );
    expect(company.status).toEqual({ type: "suspended" });
  });

  test("ignores closed suspension windows", () => {
    // Suspension that ended → entity returned to normal trading.
    const company = parseCompany(
      {
        ...baseRaw,
        Company_Status: "01",
        Sus_Beg_Date: "1140101",
        Sus_End_Date: "1140401",
      },
      new Date("2025-05-01T00:00:00Z"),
    );
    expect(company.status).toEqual({ type: "active" });
  });

  test("ignores future suspension windows", () => {
    const company = parseCompany(
      {
        ...baseRaw,
        Company_Status: "01",
        Sus_Beg_Date: "1140601",
        Sus_End_Date: "1141231",
      },
      new Date("2025-05-01T00:00:00Z"),
    );
    expect(company.status).toEqual({ type: "active" });
  });
});

describe("ROC date parsing (via parseCompany)", () => {
  test("handles 3-digit ROC years", () => {
    expect(
      parseCompany({ ...baseRaw, Company_Setup_Date: "1150525" }).setupDate,
    ).toBe("2026-05-25");
  });

  test("handles 2-digit ROC years (e.g. pre-2011 registrations)", () => {
    // ROC 76 / 1987-02-21 — TSMC's founding date. The leading zero
    // means the string is 7 chars; parser must accept both widths.
    expect(
      parseCompany({ ...baseRaw, Company_Setup_Date: "0760221" }).setupDate,
    ).toBe("1987-02-21");
  });

  test("rejects malformed date strings without throwing", () => {
    // The whole lookup should not fail because one date field is
    // garbled upstream; surface null and keep going.
    expect(
      parseCompany({ ...baseRaw, Company_Setup_Date: "abc" }).setupDate,
    ).toBeNull();
    expect(
      parseCompany({ ...baseRaw, Company_Setup_Date: "11502" }).setupDate,
    ).toBeNull();
    expect(
      parseCompany({ ...baseRaw, Company_Setup_Date: "1151301" }).setupDate,
    ).toBeNull();
  });
});

describe("parseSearchEntry", () => {
  test("derives a compact row from a name-search hit", () => {
    const entry = parseSearchEntry(
      {
        Business_Accounting_NO: "54900838",
        Company_Name: "台積電機有限公司",
        Company_Status: "01",
        Company_Status_Desc: "核准設立",
        Company_Location: "臺中市南屯區春社里中台路61之3號",
      },
      new Date("2025-05-01T00:00:00Z"),
    );
    expect(entry).toEqual({
      taxId: "54900838",
      name: "台積電機有限公司",
      location: "臺中市南屯區春社里中台路61之3號",
      status: { type: "active" },
    });
  });

  test("uses the same suspension-window parser as full company rows", () => {
    const entry = parseSearchEntry(
      {
        Business_Accounting_NO: "54900838",
        Company_Name: "台積電機有限公司",
        Company_Status: "01",
        Sus_Beg_Date: "1140601",
        Sus_End_Date: "1141231",
      },
      new Date("2025-06-15T00:00:00Z"),
    );
    expect(entry.status).toEqual({ type: "suspended" });
  });
});
