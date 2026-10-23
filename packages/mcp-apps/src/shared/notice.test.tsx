import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { AppNotice, SearchNotice } from "./notice";
import { searchNoticeDetails } from "./notice.logic";
import type { AppSearchWarning } from "./notice.logic";

const warnings = [
  { audience: "agent", message: "Pass strict: true" },
  { audience: "user", message: "Žádná odpovídající rozhodnutí" },
  { audience: "user", message: "Žádné výsledky s filtry: Soud" },
] as const satisfies readonly AppSearchWarning[];

describe("compact search notices", () => {
  test("user notes share one closed disclosure and omit agent guidance", () => {
    const details = searchNoticeDetails(warnings);
    expect(details).toEqual([
      "Žádná odpovídající rozhodnutí",
      "Žádné výsledky s filtry: Soud",
    ]);
    const markup = renderToStaticMarkup(<SearchNotice warnings={warnings} />);
    expect(markup.match(/<details/gu)).toHaveLength(1);
    expect(markup.match(/<summary/gu)).toHaveLength(1);
    expect(markup).not.toContain(" open=");
    expect(markup).toContain("truncate");
    expect(markup).toContain("<ul");
    expect(markup).not.toContain("Pass strict");
  });

  test("adding duplicate warnings is a fixed point", () => {
    expect(searchNoticeDetails([...warnings, ...warnings])).toEqual(
      searchNoticeDetails(warnings),
    );
  });

  test("empty warnings and agent-only guidance render nothing", () => {
    expect(searchNoticeDetails([])).toEqual([]);
    expect(
      renderToStaticMarkup(<SearchNotice warnings={[warnings[0]]} />),
    ).toBe("");
    expect(renderToStaticMarkup(<AppNotice details={[]} />)).toBe("");
  });
});
