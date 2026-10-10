import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { InspectorEntityTab } from "../inspector/entity-tab";
import { DocumentIdentityBadge } from "./document-identity-badge";
import { statuteIdentityLabels } from "./document-identity-badge.logic";
import type { DocumentIdentity } from "./document-identity-badge.logic";

const markup = (identity: DocumentIdentity) =>
  renderToStaticMarkup(<DocumentIdentityBadge identity={identity} />);

const STATUTE = {
  kind: "statute",
  number: "172",
  year: "2026",
} as const satisfies DocumentIdentity;

describe("document identity badge", () => {
  test("statutes keep both width-dependent forms of their own identity", () => {
    expect(statuteIdentityLabels(STATUTE)).toEqual({
      short: "172/26",
      long: "172/2026",
    });
    expect(markup(STATUTE)).toContain(">172/26</bdi>");
    expect(markup(STATUTE)).toContain(">172/2026</bdi>");
    expect(markup(STATUTE)).not.toContain("<svg");
  });

  test.each([
    [{ kind: "statute", number: "172", year: null }, "172"],
    [{ kind: "statute", number: null, year: "2026" }, "2026"],
  ] as const)("retains partial statute identity %j", (identity, label) => {
    expect(markup(identity)).toContain(`>${label}</bdi>`);
    expect(markup(identity)).not.toContain("<svg");
  });

  test.each(["NS", "ÚS", "NSS", "CJEU", "Kúria", "SCOTUS"])(
    "decisions reuse the court chip for %s",
    (courtAbbreviation) => {
      const result = markup({
        kind: "decision",
        courtAbbreviation,
        courtTier: "constitutional",
      });
      expect(result).toContain('data-slot="court-badge"');
      expect(result).toContain(`>${courtAbbreviation}</span>`);
      expect(result).toContain("border-foreground");
      expect(result).not.toContain("<svg");
    },
  );

  test.each([
    { kind: "unknown" },
    { kind: "decision", courtAbbreviation: null },
    { kind: "decision", courtAbbreviation: "  " },
    { kind: "statute", number: null, year: null },
  ] as const)(
    "uses a generic document mark only without known identity: %j",
    (identity) => {
      const result = markup(identity);
      expect(result).toContain("<svg");
      expect(result).toContain('data-kind="unknown"');
      expect(result).not.toContain('data-slot="court-badge"');
    },
  );

  test.each([true, false])(
    "the rail preserves the same identity when active=%s",
    (active) => {
      const result = renderToStaticMarkup(
        <InspectorEntityTab
          active={active}
          label="172/2026 Sb., zákon"
          inactiveIcon="legible"
          icon={<DocumentIdentityBadge identity={STATUTE} />}
        />,
      );
      expect(result).toContain('data-kind="statute"');
      expect(result).toContain("172/26");
      expect(result).not.toContain("opacity-70");
    },
  );
});
