import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  checkDocumentIdentitySources,
  readDocumentIdentitySources,
} from "./document-identity-guard";

const OWNER = "packages/ui/src/components/document-identity-badge.tsx";
const fixture = (filename: string, source: string) =>
  new Map([
    [OWNER, "export const DocumentIdentityBadge = () => <span />;"],
    [filename, source],
  ]);

// These are synthetic renderers with the same JSX and row vocabulary as the
// producers. Removing a badge while retaining an unused import must fail.
const ROWS = {
  statute: `export const StatuteResults = ({ hits }: { hits: StatuteSearchHit[] }) => <ul>{hits.map(hit => <li><DocumentIdentityBadge identity={hit.identity} />{hit.title}</li>)}</ul>;`,
  decision: `export const ResultsTable = ({ rows }) => <TableRow>{rows.map(row => <TableCell><DocumentIdentityBadge identity={row.identity} />{row.caseNumber}</TableCell>)}</TableRow>;`,
  recents: `export const DocumentRecents = ({ items }) => <ul>{items.map(item => <li><DocumentIdentityBadge identity={item.identity} />{item.courtAbbreviation}</li>)}</ul>;`,
  rail: `export const StatuteRailIcon = ({ tab }: InspectorRailIconProps<StatuteViewPayload>) => <DocumentIdentityBadge identity={tab.payload.identity} />;`,
} as const;
const IMPORT =
  'import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";\n';

describe("document identity ownership guard", () => {
  test.each(Object.entries(ROWS))(
    "discovers %s and rejects a hand-rolled identity even with an unused shared import",
    (_name, row) => {
      const filename = "apps/web/src/features/statutes/new-results.tsx";
      const good = checkDocumentIdentitySources(
        fixture(filename, IMPORT + row),
      );
      expect(good.surfaces).toHaveLength(1);
      expect(good.violations).toEqual([]);
      const mutated = row.replace(
        /<DocumentIdentityBadge[^>]*\/>/u,
        '<span data-kind="statute">172/26</span>',
      );
      expect(mutated).not.toBe(row);
      const bad = checkDocumentIdentitySources(
        fixture(filename, IMPORT + mutated),
      );
      expect(bad.surfaces).toEqual(good.surfaces);
      expect(bad.violations).toEqual(good.surfaces);
    },
  );

  test("follows a rendered adapter, rather than accepting an imported but unused badge", () => {
    const sources = fixture(
      "apps/web/src/features/statutes/rows.tsx",
      `import { StatuteBadge } from "./adapter";\nexport const StatuteResults = ({ hits }: { hits: StatuteSearchHit[] }) => <ul>{hits.map(hit => <li><StatuteBadge identity={hit.identity} />{hit.title}</li>)}</ul>`,
    );
    sources.set(
      "apps/web/src/features/statutes/adapter.tsx",
      `${
        IMPORT
      }export const StatuteBadge = ({ identity }) => <DocumentIdentityBadge identity={identity} />;`,
    );
    expect(checkDocumentIdentitySources(sources).violations).toEqual([]);
    sources.set(
      "apps/web/src/features/statutes/adapter.tsx",
      `${IMPORT}export const StatuteBadge = () => <svg />;`,
    );
    expect(checkDocumentIdentitySources(sources).violations).toHaveLength(1);
  });

  test("every discovered repository document row or rail reaches the shared badge", () => {
    const sources = readDocumentIdentitySources(
      path.resolve(import.meta.dir, ".."),
    );
    const result = checkDocumentIdentitySources(sources);
    expect(result.surfaces.length).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
    for (const surface of [
      "apps/web/src/features/statutes/statute-inspector-registration.tsx#StatuteRailIcon",
      "apps/web/src/features/statutes/components/statute-search-results.tsx#StatuteSearchResults",
      "apps/web/src/components/search-dialog-results.tsx#SearchHitIcon",
      "apps/api/src/mcp/apps/case-law-results/app.tsx#ResultsTable",
    ]) {
      expect(result.surfaces).toContain(surface);
    }
  });
});
