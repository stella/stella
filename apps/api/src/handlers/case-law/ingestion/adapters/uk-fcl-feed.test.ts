import { expect, test } from "bun:test";

import { ParseXmlError } from "@/api/handlers/case-law/ingestion/parsers/parse-xml-error";
import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
} from "@/api/lib/legal-search/source-raw-envelope";

import {
  buildUkFclDecision,
  readUkFclFeed,
  reparseUkFclStoredRaw,
} from "./uk-fcl-feed";

const feed = await Bun.file(
  new URL("__fixtures__/uk-fcl.atom.xml", import.meta.url),
).text();
const document = await Bun.file(
  new URL("../parsers/__fixtures__/uk-fcl.xml", import.meta.url),
).text();
const sourceDocumentId = "d-00000000-0000-4000-8000-000000000001";
const build = (raw = feed, xml = document) =>
  buildUkFclDecision({ feed: raw, document: xml, sourceDocumentId }).unwrap();
const stored = () => {
  const result = build();
  return {
    raw: new TextEncoder().encode(result.sourceRaw),
    contentType: result.sourceRawContentType ?? null,
    caseNumber: result.caseNumber,
    sourceDocumentId,
    language: result.language,
    court: result.court,
    ecli: null,
    decisionDate: result.decisionDate ?? null,
    decisionType: null,
    sourceUrl: result.sourceUrl ?? null,
    documentUrl: result.documentUrl ?? null,
    metadata: result.metadata,
  };
};

test("feed identity and repeated fields survive raw assembly and offline replay", () => {
  const listed = readUkFclFeed(feed, 50).unwrap().entries;
  expect(listed).toHaveLength(1);
  expect(listed.at(0)).toMatchObject({
    sourceDocumentId,
    caseNumber: "[2026] UKSC 900001",
    courtSlug: "uksc",
    identifiers: [{ type: "ukncn" }, { type: "fclid" }],
  });
  const initial = build();
  expect(initial.plainTextOutcome.type).toBe("accepted");
  expect(initial.sourceDocumentId).toBe(sourceDocumentId);
  expect(initial.metadata["feedFields"]).toMatchObject({
    "{http://www.w3.org/2005/Atom}link": [{}, {}, {}],
  });
  const archived = decodeSourceRawEnvelope(initial.sourceRaw ?? "");
  expect(archived?.["document"]).toBe(document);
  expect(
    readUkFclFeed(archived?.["listing"] ?? "", 50).unwrap().entries,
  ).toEqual(listed);
  expect(archived?.["listing"]).not.toContain("Synthetic judgment feed");
  expect(initial.textFields.headnote).toEqual({
    type: "absent",
    reason: "not_published",
  });
  expect(initial.metadata).toMatchObject({
    ecli: { type: "absent", reason: "not_published" },
  });
  expect(reparseUkFclStoredRaw(stored())).toEqual({
    type: "parsed",
    result: initial,
  });
  expect(
    reparseUkFclStoredRaw({ ...stored(), caseNumber: "[2026] UKSC 900002" }),
  ).toMatchObject({ type: "rejected", rejection: "identity-mismatch" });
  expect(
    reparseUkFclStoredRaw({
      ...stored(),
      raw: new TextEncoder().encode(document),
    }),
  ).toMatchObject({ type: "rejected", rejection: "unsupported-content" });
});

test("markup refresh keeps canonical output and changes to body text replace it", () => {
  const initial = build();
  const refreshed = build(
    feed.replace("2026-01-03T12:00:00Z", "2026-01-04T12:00:00Z"),
    document.replace("<judgment ", '<judgment refresh="synthetic" '),
  );
  expect(refreshed.rawHash).not.toBe(initial.rawHash);
  expect(refreshed.fulltext).toBe(initial.fulltext);
  expect(refreshed.documentAst).toEqual(initial.documentAst);
  expect(refreshed.sections).toEqual(initial.sections);
  const revised = build(
    feed.replace("a".repeat(64), () => "b".repeat(64)),
    document.replace("Compare ", "Consider "),
  );
  expect(revised.rawHash).not.toBe(initial.rawHash);
  expect(revised.fulltext).not.toBe(initial.fulltext);
});

test("only a same-origin next link controls pagination", () => {
  const addLink = (href: string, rel = "next") =>
    feed.replace("</feed>", () => `<link rel="${rel}" href="${href}"/></feed>`);
  expect(
    readUkFclFeed(addLink("/atom.xml?page=999", "last"), 50).unwrap().next,
  ).toBeNull();
  expect(readUkFclFeed(addLink("/atom.xml?page=2"), 50).unwrap().next).toBe(
    "https://caselaw.nationalarchives.gov.uk/atom.xml?page=2",
  );
  for (const href of [
    "https://example.test/atom.xml",
    "/other.xml",
    ["javascript", "alert(1)"].join(":"),
    "https://user:pass@caselaw.nationalarchives.gov.uk/atom.xml",
  ]) {
    expect(readUkFclFeed(addLink(href), 50).isErr()).toBe(true);
  }
});

test("namespace aliases preserve discovery and malformed inputs are rejected", () => {
  const alias = feed
    .replaceAll("xmlns:tna=", "xmlns:source=")
    .replaceAll("tna:", "source:");
  expect(alias).not.toBe(feed);
  expect(readUkFclFeed(alias, 50).unwrap()).toEqual(
    readUkFclFeed(feed, 50).unwrap(),
  );
  for (const raw of [
    feed.slice(0, -20),
    feed.replace("2026-01-03T12:00:00Z", "invalid"),
    feed.replace(/<tna:uri>[^<]+<\/tna:uri>/u, "<tna:uri>../escape</tna:uri>"),
    feed.replace('xmlns="http://www.w3.org/2005/Atom"', 'xmlns="urn:wrong"'),
  ]) {
    expect(readUkFclFeed(raw, 50).isErr()).toBe(true);
  }
  expect(
    buildUkFclDecision({ feed, document, sourceDocumentId: "missing" }).isErr(),
  ).toBe(true);
  expect(
    buildUkFclDecision({
      feed: feed.replace("[2026] UKSC 900001", "[2026] UKSC 900002"),
      document,
      sourceDocumentId,
    }).isErr(),
  ).toBe(true);
});

const syntheticEntry = feed.slice(
  feed.indexOf("<entry>"),
  feed.indexOf("</entry>") + "</entry>".length,
);
const refusalCases = [
  {
    name: "malformed XML",
    raw: feed.slice(0, -20),
    message: "Atom feed XML could not be parsed",
  },
  {
    name: "wrong root namespace",
    raw: feed.replace(
      'xmlns="http://www.w3.org/2005/Atom"',
      'xmlns="urn:wrong"',
    ),
    message: "Expected an Atom feed root",
  },
  {
    name: "document type declaration",
    raw: feed.replace("<feed ", "<!DOCTYPE feed><feed "),
    message: "without a document type declaration",
  },
  {
    name: "invalid identity",
    raw: feed.replace(
      /<tna:uri>[^<]+<\/tna:uri>/u,
      "<tna:uri>../escape</tna:uri>",
    ),
    message: "valid tna:uri document identity",
  },
  {
    name: "invalid content hash",
    raw: feed.replace("a".repeat(64), "invalid"),
    message: "64-digit hexadecimal tna:contenthash",
  },
  {
    name: "missing updated field",
    raw: feed.replace(/<updated>[^<]+<\/updated>/u, ""),
    message: "requires updated",
  },
  {
    name: "invalid timestamp",
    raw: feed.replace("2026-01-03T12:00:00Z", "invalid"),
    message: "valid timestamp with an offset",
  },
  {
    name: "duplicate identities",
    raw: feed.replace("</feed>", () => `${syntheticEntry}</feed>`),
    message: "duplicate tna:uri document identities",
  },
  {
    name: "ambiguous next page",
    raw: feed.replace(
      "</feed>",
      '<link rel="next" href="/atom.xml?page=2"/><link rel="next" href="/atom.xml?page=3"/></feed>',
    ),
    message: "at most one next page link",
  },
  {
    name: "missing next href",
    raw: feed.replace("</feed>", '<link rel="next"/></feed>'),
    message: "requires an href attribute",
  },
  {
    name: "unparseable next URL",
    raw: feed.replace(
      "</feed>",
      '<link rel="next" href="https://[invalid"/></feed>',
    ),
    message: "could not be parsed as a URL",
  },
  {
    name: "invalid next URL origin",
    raw: feed.replace(
      "</feed>",
      '<link rel="next" href="https://example.test/atom.xml"/></feed>',
    ),
    message: "must target the publisher",
  },
  {
    name: "invalid later entry",
    raw: feed.replace(
      "</feed>",
      () =>
        `${syntheticEntry.replace("2026-01-03T12:00:00Z", "invalid")}</feed>`,
    ),
    message: "valid timestamp with an offset",
  },
];

for (const { name, raw, message } of refusalCases) {
  test(`feed returns a typed refusal for ${name}`, () => {
    expect(raw).not.toBe(feed);
    const result = readUkFclFeed(raw, 50);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }
    expect(result.error).toBeInstanceOf(ParseXmlError);
    expect(result.error.message).toContain(message);
  });
}

const citationElement =
  /<tna:identifier type="ukncn"[^>]*>[^<]*<\/tna:identifier>/u;
for (const { name, raw } of [
  { name: "missing", raw: feed.replace(citationElement, "") },
  {
    name: "empty",
    raw: feed.replace(
      citationElement,
      '<tna:identifier type="ukncn"> </tna:identifier>',
    ),
  },
  {
    name: "duplicate",
    raw: feed.replace(citationElement, (citation) => citation + citation),
  },
]) {
  test(`${name} feed citation refuses discovery, assembly and replay`, () => {
    expect(raw).not.toBe(feed);
    const listed = readUkFclFeed(raw, 50);
    expect(listed.isErr()).toBe(true);
    if (listed.isOk()) {
      return;
    }
    expect(listed.error).toBeInstanceOf(ParseXmlError);
    expect(listed.error.message).toContain("exactly one nonempty ukncn");
    expect(
      buildUkFclDecision({ feed: raw, document, sourceDocumentId }).isErr(),
    ).toBe(true);
    expect(
      reparseUkFclStoredRaw({
        ...stored(),
        raw: new TextEncoder().encode(
          encodeSourceRawEnvelope({ listing: raw, document }),
        ),
      }),
    ).toMatchObject({
      type: "rejected",
      rejection: "no-document",
      detail: listed.error.message,
    });
  });
}

test("a different judgment citation refuses assembly and stored-raw replay", () => {
  const differentDocument = document.replaceAll(
    "[2026] UKSC 900001",
    "[2026] UKSC 900002",
  );
  expect(differentDocument).not.toBe(document);
  const result = buildUkFclDecision({
    feed,
    document: differentDocument,
    sourceDocumentId,
  });
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    return;
  }
  expect(result.error).toBeInstanceOf(ParseXmlError);
  expect(result.error.message).toBe("Feed and document citations differ");
  expect(
    reparseUkFclStoredRaw({
      ...stored(),
      raw: new TextEncoder().encode(
        encodeSourceRawEnvelope({ listing: feed, document: differentDocument }),
      ),
    }),
  ).toMatchObject({
    type: "rejected",
    rejection: "no-document",
    detail: result.error.message,
  });
});

test("feed end requires a short or empty page without a next link", () => {
  expect(readUkFclFeed(feed, 2).unwrap().next).toBeNull();
  const empty = feed.replace(syntheticEntry, "");
  expect(empty).not.toBe(feed);
  expect(readUkFclFeed(empty, 1).unwrap()).toEqual({ entries: [], next: null });
  const full = readUkFclFeed(feed, 1);
  expect(full.isErr()).toBe(true);
  if (full.isErr()) {
    expect(full.error).toBeInstanceOf(ParseXmlError);
    expect(full.error.message).toContain("Feed end not proven");
  }
  const continuing = feed.replace(
    "</feed>",
    '<link rel="next" href="/atom.xml?page=2"/></feed>',
  );
  expect(readUkFclFeed(continuing, 1).unwrap().next).toBe(
    "https://caselaw.nationalarchives.gov.uk/atom.xml?page=2",
  );
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "invalid requested page size %s produces a typed refusal",
  (perPage) => {
    const result = readUkFclFeed(feed, perPage);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ParseXmlError);
      expect(result.error.message).toContain("per_page");
    }
  },
);

test("sibling entries cannot change a decision's raw hash or offline replay", () => {
  const sibling = syntheticEntry.replaceAll(
    sourceDocumentId,
    "d-00000000-0000-4000-8000-000000000002",
  );
  const combined = feed.replace("</feed>", () => `${sibling}</feed>`);
  const changedSibling = sibling.replace(
    "Invented Amber v Invented Birch",
    "Invented Cedar v Invented Dune",
  );
  expect(changedSibling).not.toBe(sibling);
  const changed = feed.replace("</feed>", () => `${changedSibling}</feed>`);
  expect(readUkFclFeed(combined, 50).unwrap().entries).toHaveLength(2);
  const initial = build(combined);
  const revised = build(changed);
  expect(revised.rawHash).toBe(initial.rawHash);
  expect(initial.rawHash).toBe(build().rawHash);
  const listing = decodeSourceRawEnvelope(initial.sourceRaw ?? "")?.["listing"];
  expect(readUkFclFeed(listing ?? "", 50).unwrap().entries).toHaveLength(1);
  expect(listing).not.toContain("d-00000000-0000-4000-8000-000000000002");
  const replayed = reparseUkFclStoredRaw({
    ...stored(),
    raw: new TextEncoder().encode(initial.sourceRaw),
  });
  expect(replayed).toEqual({ type: "parsed", result: initial });
});
