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

  test.each([
    {
      kind: "statute",
      markup: "<span>{entry.statuteNumber}/{entry.statuteYear}</span>",
    },
    {
      kind: "decision",
      markup: "<CourtBadge abbreviation={entry.courtAbbreviation} />",
    },
  ])(
    "law-home recents reject a hand-rolled $kind badge in a local adapter",
    ({ kind, markup }) => {
      const filename = "apps/web/src/routes/law/-law-home/law-recent.tsx";
      const row = `export const LawRecent = ({ entries }) => <ul>{entries.map(entry => <li><LocalIdentity entry={entry} />{entry.title}</li>)}</ul>;`;
      const shared = `const LocalIdentity = ({ entry }) => entry.kind === "${kind}" ? <DocumentIdentityBadge identity={entry.identity} /> : null;`;
      const good = checkDocumentIdentitySources(
        fixture(filename, IMPORT + row + shared),
      );
      expect(good.surfaces).toEqual([`${filename}#LawRecent`]);
      expect(good.violations).toEqual([]);
      // Mutation: retain the local per-kind adapter and import, replace its shared badge.
      const handRolled = shared.replace(
        /<DocumentIdentityBadge[^>]*\/>/u,
        () => markup,
      );
      expect(handRolled).not.toBe(shared);
      const bad = checkDocumentIdentitySources(
        fixture(filename, IMPORT + row + handRolled),
      );
      expect(bad.surfaces).toEqual(good.surfaces);
      expect(bad.violations).toEqual(good.surfaces);
    },
  );

  test.each([
    `entry.kind === "decision" ? <DocumentIdentityBadge identity={entry.identity} /> : entry.kind === "statute" ? <DocumentIdentityBadge identity={entry.identity} /> : null`,
    `{ switch (entry.kind) { case "decision": return <DocumentIdentityBadge identity={entry.identity} />; case "statute": return <DocumentIdentityBadge identity={entry.identity} />; default: return null; } }`,
    `{ if (entry.kind === "decision") return <DocumentIdentityBadge identity={entry.identity} />; return <DocumentIdentityBadge identity={entry.identity} />; }`,
    `{ if (entry.kind === "decision") { return <DocumentIdentityBadge identity={entry.identity} />; } else { return <DocumentIdentityBadge identity={entry.identity} />; } }`,
  ])(
    "mixed-kind adapters require the shared badge in every identity branch",
    (body) => {
      const filename = "apps/web/src/routes/law/-law-home/mixed-recents.tsx";
      const row = `export const LawRecent = ({ entries }) => <ul>{entries.map(entry => <li><LocalIdentity entry={entry} />{entry.title}</li>)}</ul>;`;
      const shared = `const LocalIdentity = ({ entry }) => ${body};`;
      const good = checkDocumentIdentitySources(
        fixture(filename, IMPORT + row + shared),
      );
      expect(good.surfaces).toEqual([`${filename}#LawRecent`]);
      expect(good.violations).toEqual([]);
      // Keep the decision branch shared; replace only the second (statute) mark.
      const statuteStart = shared.lastIndexOf("<DocumentIdentityBadge");
      expect(statuteStart).toBeGreaterThan(
        shared.indexOf("<DocumentIdentityBadge"),
      );
      const mutated =
        shared.slice(0, statuteStart) +
        shared
          .slice(statuteStart)
          .replace(
            /<DocumentIdentityBadge[^>]*\/>/u,
            "<span>{entry.statuteNumber}/{entry.statuteYear}</span>",
          );
      expect(mutated).not.toBe(shared);
      const bad = checkDocumentIdentitySources(
        fixture(filename, IMPORT + row + mutated),
      );
      expect(bad.surfaces).toEqual(good.surfaces);
      expect(bad.violations).toEqual(good.surfaces);
    },
  );

  test("mixed-kind function adapters cannot hide an unshared identity behind a helper", () => {
    const filename = "apps/web/src/routes/law/-law-home/mixed-functions.tsx";
    const source = `${IMPORT}
      export const LawRecent = ({ entries }) => <ul>{entries.map(entry => <li><LocalIdentity entry={entry} />{entry.title}</li>)}</ul>;
      const LocalIdentity = ({ entry }) => entry.kind === "decision" ? decisionIdentity(entry) : statuteIdentity(entry);
      const decisionIdentity = entry => <DocumentIdentityBadge identity={entry.identity} />;
      const statuteIdentity = entry => <DocumentIdentityBadge identity={entry.identity} />;`;
    const good = checkDocumentIdentitySources(fixture(filename, source));
    expect(good.surfaces).toEqual([`${filename}#LawRecent`]);
    expect(good.violations).toEqual([]);
    const mutated = source.replace(
      "const statuteIdentity = entry => <DocumentIdentityBadge identity={entry.identity} />",
      "const statuteIdentity = entry => <span>{entry.statuteNumber}/{entry.statuteYear}</span>",
    );
    expect(mutated).not.toBe(source);
    const bad = checkDocumentIdentitySources(fixture(filename, mutated));
    expect(bad.surfaces).toEqual(good.surfaces);
    expect(bad.violations).toEqual(good.surfaces);
  });

  test("unrelated document references beside a generic table do not classify its rows", () => {
    const filename = "apps/web/src/routes/dev/playground.tsx";
    const source = `export const Playground = () => <main><TableRow><TableCell>Matter</TableCell></TableRow><Mention value={value} /></main>;
      const Mention = ({ value }) => value.type === "decision" ? <a>{value.title}</a> : null;`;
    const result = checkDocumentIdentitySources(fixture(filename, source));
    expect(result.surfaces).toEqual([]);
    expect(result.violations).toEqual([]);
  });

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

  test.each([
    "type ListProps = { hits: StatuteSearchHit[] }; export const RenamedAliasList = ({ hits }: ListProps) => <ul>{hits.map(hit => <li>{hit.title}</li>)}</ul>;",
    "export const RenamedList = ({ hits }: { hits: StatuteSearchHit[] }) => <ul>{hits.map(hit => <li>{hit.title}</li>)}</ul>;",
    "export const WrappedList = memo(({ hits }: { hits: StatuteSearchHit[] }) => <ul>{hits.map(hit => <li>{hit.title}</li>)}</ul>);",
    "export const RefList = forwardRef(({ hits }: { hits: StatuteSearchHit[] }, ref) => <ul>{hits.map(hit => <li>{hit.title}</li>)}</ul>);",
    "export default ({ hits }: { hits: StatuteSearchHit[] }) => <ul>{hits.map(hit => <li>{hit.title}</li>)}</ul>;",
    "export default function ({ hits }: { hits: StatuteSearchHit[] }) { return <ul>{hits.map(hit => <li>{hit.title}</li>)}</ul>; }",
  ])(
    "a new document list cannot evade discovery through its name or component wrapper",
    (source) => {
      const result = checkDocumentIdentitySources(
        fixture("apps/web/src/features/statutes/another-list.tsx", source),
      );
      expect(result.surfaces).toHaveLength(1);
      expect(result.violations).toEqual(result.surfaces);
    },
  );

  test.each([
    "const unused = <DocumentIdentityBadge identity={hit.identity} />;",
    "const unused = DocumentIdentityBadge({ identity: hit.identity });",
    "if (false) return <DocumentIdentityBadge identity={hit.identity} />;",
  ])(
    "discarded and unreachable badge output does not protect a document row",
    (discarded) => {
      const source = `${IMPORT}export const DecisionRow = ({ hit }) => { ${discarded} return <li>{hit.caseNumber}</li>; };`;
      const result = checkDocumentIdentitySources(
        fixture("apps/web/src/features/case-law/another-row.tsx", source),
      );
      expect(result.surfaces).toHaveLength(1);
      expect(result.violations).toEqual(result.surfaces);
    },
  );

  test("every requested surface fails the guard if its shared rendering is replaced", () => {
    const sources = readDocumentIdentitySources(
      path.resolve(import.meta.dir, ".."),
    );
    const baseline = checkDocumentIdentitySources(sources);
    expect(baseline.violations).toEqual([]);
    for (const [filename, source] of sources) {
      if (!source.includes("<DocumentIdentityBadge")) {
        continue;
      }
      const ownedSurfaces = baseline.surfaces.filter((surface) =>
        surface.startsWith(`${filename}#`),
      );
      if (ownedSurfaces.length === 0) {
        continue;
      }
      const replacement = source.replaceAll("<DocumentIdentityBadge", "<span");
      expect(replacement).not.toBe(source);
      const mutated = new Map(sources);
      mutated.set(filename, replacement);
      const result = checkDocumentIdentitySources(mutated);
      for (const surface of ownedSurfaces) {
        expect(result.violations).toContain(surface);
      }
    }
  }, 30_000);

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
      "apps/web/src/components/search-dialog-results.tsx#RecentFileIcon",
      "apps/web/src/features/case-law/components/decision-cells.tsx#CaseNumberCell",
      "apps/api/src/mcp/apps/case-law-results/app.tsx#ResultTableRow",
    ]) {
      expect(result.surfaces).toContain(surface);
    }
  });
});
