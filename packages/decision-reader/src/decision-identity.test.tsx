import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { BidiText } from "@stll/ui/bidi-text";
import { BreadcrumbPage } from "@stll/ui/breadcrumb";

import { CourtName } from "./court-name";
import { CourtTierBadge } from "./court-tier-badge";
import { DecisionIdentity } from "./decision-identity";

test.each(["ÚS", null, "  "])(
  "breadcrumb court identity depends on the abbreviation, across all tiers: %j",
  (courtAbbreviation) => {
    for (const courtTier of [
      "constitutional",
      "supreme",
      "regional",
      "other",
      undefined,
    ] as const) {
      const props = {
        caseNumber: "I. ÚS 281/97",
        court: "Ústavní soud",
        courtAbbreviation,
        courtTier,
      };
      // The public-law breadcrumb before extraction: this serialized surface is the contract.
      const previous = renderToStaticMarkup(
        <>
          <BreadcrumbPage className="min-w-0 flex-1 truncate font-medium">
            <BidiText>{props.caseNumber}</BidiText>
          </BreadcrumbPage>
          <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 truncate max-sm:hidden">
            ·
            <CourtName
              abbreviation={props.courtAbbreviation}
              court={props.court}
              tier={courtTier}
            />
          </span>
        </>,
      );
      const shared = renderToStaticMarkup(<DecisionIdentity {...props} />);
      expect(shared).toBe(previous);
      expect(shared.includes('data-slot="court-badge"')).toBe(
        Boolean(courtAbbreviation?.trim()),
      );
      expect(shared.includes('data-kind="unknown"')).toBe(
        !courtAbbreviation?.trim(),
      );
    }
  },
);

test("decision identity preserves publisher names and isolates bidirectional case numbers", () => {
  const html = renderToStaticMarkup(
    <DecisionIdentity
      caseNumber="C-1/2026"
      court="محكمة <العليا>"
      courtAbbreviation={null}
      courtTier="supreme"
    />,
  );
  expect(html).toContain("C-1/2026</bdi>");
  expect(html).toContain("محكمة &lt;العليا&gt;");
  expect(html).not.toContain('data-slot="court-badge"');
});

test("shared court identity preserves inline chip sizing", () => {
  const inline = renderToStaticMarkup(
    <CourtTierBadge abbreviation="NSS" tier="supreme" size="inline" />,
  );
  const standalone = renderToStaticMarkup(
    <CourtTierBadge abbreviation="NSS" tier="supreme" />,
  );
  for (const markup of [inline, standalone]) {
    expect(markup).toContain('data-kind="decision"');
    expect(markup).toContain('data-slot="court-badge"');
    expect(markup).toContain(">NSS</span>");
  }
  expect(inline).toContain("leading-3.5");
  expect(inline).not.toContain("leading-4");
  expect(standalone).toContain("leading-4");
  expect(standalone).not.toContain("leading-3.5");
});
