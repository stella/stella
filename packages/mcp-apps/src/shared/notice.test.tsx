import { renderToStaticMarkup } from "react-dom/server";

import { fireEvent, render, screen } from "@testing-library/react";
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
  test("user notes share one closed accordion and omit agent guidance", () => {
    const details = searchNoticeDetails(warnings);
    expect(details).toEqual([
      "Žádná odpovídající rozhodnutí",
      "Žádné výsledky s filtry: Soud",
    ]);
    render(<SearchNotice warnings={warnings} />);

    const trigger = screen.getByRole("button", { name: details.join(" · ") });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toBe(details.join(" · "));
    expect(screen.queryByRole("list")).toBeNull();
    expect(document.body.textContent).not.toContain("Pass strict");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getAllByRole("listitem").map(({ textContent }) => textContent),
    ).toEqual(details);

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list")).toBeNull();
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
