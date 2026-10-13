import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";

import { BidiText } from "@stll/ui/bidi-text";
import { BreadcrumbPage } from "@stll/ui/breadcrumb";

import { CourtName } from "./court-name";
import { DecisionIdentity } from "./decision-identity";

test("shared decision identity preserves the public breadcrumb DOM and court treatment", () => {
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
      courtAbbreviation: "ÚS",
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
    expect(shared).toContain('data-slot="court-badge"');
  }
});

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
