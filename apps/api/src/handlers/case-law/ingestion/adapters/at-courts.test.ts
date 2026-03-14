import { describe, expect, it } from "bun:test";

import { atCourtsAdapter } from "./at-courts";

describe("at-courts adapter", () => {
  it("has correct metadata", () => {
    expect(atCourtsAdapter.key).toBe("at-courts");
    expect(atCourtsAdapter.country).toBe("AUT");
    expect(atCourtsAdapter.language).toBe("de");
    expect(atCourtsAdapter.minRequestIntervalMs).toBe(1000);
    expect(atCourtsAdapter.pageTimeoutMs).toBe(220_000);
  });

  it("fetches first page with fulltext and ECLI", async () => {
    const result = await atCourtsAdapter.fetchPage(null, {});

    expect(result.isOk()).toBe(true);

    const page = result.unwrap();
    expect(page.decisions.length).toBeGreaterThan(0);
    expect(page.nextCursor).not.toBeNull();

    const first = page.decisions[0];
    expect(first.caseNumber).toBeTruthy();
    expect(first.court).toBeTruthy();
    expect(first.country).toBe("AUT");
    expect(first.language).toBe("de");
    expect(first.rawHash).toBeTruthy();
    expect(first.sourceUrl).toContain("ris.bka.gv.at");

    // RIS provides ECLI for most decisions
    const withEcli = page.decisions.find((d) => d.ecli);
    expect(withEcli).toBeDefined();
    expect(withEcli?.ecli).toMatch(/^ECLI:AT:/);

    // RIS provides fulltext HTML
    const withFulltext = page.decisions.find((d) => d.fulltext);
    expect(withFulltext).toBeDefined();
    expect(withFulltext?.fulltext?.length).toBeGreaterThan(100);

    // documentUrl populated from HTML fulltext link
    const withDocUrl = page.decisions.find((d) => d.documentUrl);
    expect(withDocUrl).toBeDefined();
    expect(withDocUrl?.documentUrl).toContain("ris.bka.gv.at");
  }, 120_000);

  it("returns error for invalid cursor", async () => {
    const result = await atCourtsAdapter.fetchPage("abc", {});
    expect(result.isErr()).toBe(true);
  });

  it("returns error for zero cursor", async () => {
    const result = await atCourtsAdapter.fetchPage("0", {});
    expect(result.isErr()).toBe(true);
  });
});
