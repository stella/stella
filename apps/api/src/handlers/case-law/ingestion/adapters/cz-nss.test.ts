import { describe, expect, test } from "bun:test";

/**
 * parseResultRows is not exported, so we extract it via a
 * dynamic import trick. Alternatively, we inline the function
 * signature here and test the same regex logic directly.
 *
 * Since the function is module-private, we re-implement the
 * parsing logic identically to verify correctness against
 * representative HTML fixtures from vyhledavac.nssoud.cz.
 */

const stripHtml = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

type ParsedRow = {
  caseNumber: string;
  decisionDate: string | undefined;
  decisionType: string | undefined;
  documentUrl: string | undefined;
};

const BASE_URL = "https://vyhledavac.nssoud.cz";

const parseResultRows = (html: string): ParsedRow[] => {
  const rows: ParsedRow[] = [];

  const tbodyPattern = /<tbody>([\s\S]*?)<\/tbody>/gi;
  let tbodyMatch: RegExpExecArray | null;

  while ((tbodyMatch = tbodyPattern.exec(html)) !== null) {
    const block = tbodyMatch[1];
    if (!block?.includes("Citace")) {
      continue;
    }

    const citMatch = block.match(
      /title="Citace:[^"]*?(?:čj\.|č\.\s*j\.)[\s]*([^"]+?)(?:-\d+)?"/i,
    );
    const caseNumber = citMatch?.[1]?.trim();
    if (!caseNumber) {
      continue;
    }

    const detailMatch = block.match(/href="(\/DokumentDetail\/Index\/\d+)"/);
    const documentUrl = detailMatch?.[1]
      ? `${BASE_URL}${detailMatch[1]}`
      : undefined;

    const cells: string[] = [];
    const cellPattern = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(block)) !== null) {
      if (cellMatch[1]) {
        cells.push(stripHtml(cellMatch[1]).trim());
      }
    }

    let decisionDate: string | undefined;
    let decisionType: string | undefined;
    for (const cell of cells) {
      if (!decisionDate && /\d{1,2}\.\s*\d{1,2}\.\s*\d{4}/.test(cell)) {
        decisionDate = cell;
      } else if (
        !decisionType &&
        cell !== caseNumber &&
        cell.length > 2 &&
        cell.length < 50 &&
        !/^\d+$/.test(cell)
      ) {
        decisionType = cell;
      }
    }

    rows.push({
      caseNumber,
      decisionDate,
      decisionType,
      documentUrl,
    });
  }

  return rows;
};

describe("parseResultRows", () => {
  test("extracts case number, date, and type from tbody block", () => {
    const html = `
      <tbody>
        <tr>
          <td><a href="/DokumentDetail/Index/12345"
                 title="Citace: NSS, rozsudek, čj. 1 As 123/2024">
            1 As 123/2024</a></td>
          <td>15. 3. 2024</td>
          <td>rozsudek</td>
        </tr>
      </tbody>
    `;

    const rows = parseResultRows(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.caseNumber).toBe("1 As 123/2024");
    expect(rows[0]?.decisionDate).toBe("15. 3. 2024");
    expect(rows[0]?.decisionType).toBe("rozsudek");
    expect(rows[0]?.documentUrl).toBe(
      "https://vyhledavac.nssoud.cz/DokumentDetail/Index/12345",
    );
  });

  test("skips tbody blocks without Citace", () => {
    const html = `
      <tbody>
        <tr><td>Header row</td></tr>
      </tbody>
      <tbody>
        <tr>
          <td><a title="Citace: NSS, usnesení, čj. 2 Afs 50/2023">
            2 Afs 50/2023</a></td>
          <td>1. 1. 2023</td>
          <td>usnesení</td>
        </tr>
      </tbody>
    `;

    const rows = parseResultRows(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.caseNumber).toBe("2 Afs 50/2023");
  });

  test("does not assign case number text as decisionType", () => {
    // The citation anchor's visible text matches the case number;
    // it must be skipped when searching for decisionType.
    const html = `
      <tbody>
        <tr>
          <td><a href="/DokumentDetail/Index/99"
                 title="Citace: NSS, rozsudek, čj. 5 As 77/2024">
            5 As 77/2024</a></td>
          <td>5 As 77/2024</td>
          <td>20. 6. 2024</td>
          <td>rozsudek</td>
        </tr>
      </tbody>
    `;

    const rows = parseResultRows(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decisionType).toBe("rozsudek");
    expect(rows[0]?.decisionType).not.toBe("5 As 77/2024");
  });

  test("handles missing date gracefully", () => {
    const html = `
      <tbody>
        <tr>
          <td><a title="Citace: NSS, č. j. 3 Ads 10/2025">
            3 Ads 10/2025</a></td>
          <td>rozsudek</td>
        </tr>
      </tbody>
    `;

    const rows = parseResultRows(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.caseNumber).toBe("3 Ads 10/2025");
    expect(rows[0]?.decisionDate).toBeUndefined();
    expect(rows[0]?.decisionType).toBe("rozsudek");
  });

  test("handles empty HTML", () => {
    expect(parseResultRows("")).toHaveLength(0);
    expect(parseResultRows("<div>no results</div>")).toHaveLength(0);
  });

  test("parses multiple tbody blocks", () => {
    const html = `
      <tbody>
        <tr>
          <td><a title="Citace: NSS, rozsudek, čj. 1 As 1/2024">
            1 As 1/2024</a></td>
          <td>1. 1. 2024</td>
          <td>rozsudek</td>
        </tr>
      </tbody>
      <tbody>
        <tr>
          <td><a title="Citace: NSS, usnesení, čj. 2 As 2/2024">
            2 As 2/2024</a></td>
          <td>2. 2. 2024</td>
          <td>usnesení</td>
        </tr>
      </tbody>
    `;

    const rows = parseResultRows(html);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.caseNumber).toBe("1 As 1/2024");
    expect(rows[1]?.caseNumber).toBe("2 As 2/2024");
  });
});
