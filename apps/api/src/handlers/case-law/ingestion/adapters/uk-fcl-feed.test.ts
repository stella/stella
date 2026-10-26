import { expect, test } from "bun:test";

import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

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
  const listed = readUkFclFeed(feed).unwrap().entries;
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
  expect(decodeSourceRawEnvelope(initial.sourceRaw ?? "")).toEqual({
    listing: feed,
    document,
  });
  expect(initial.textFields.headnote).toEqual({
    type: "absent",
    reason: "not_published",
  });
  expect(initial.metadata["ecli"]).toEqual({
    type: "absent",
    reason: "not_published",
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
    readUkFclFeed(addLink("/atom.xml?page=999", "last")).unwrap().next,
  ).toBeNull();
  expect(readUkFclFeed(addLink("/atom.xml?page=2")).unwrap().next).toBe(
    "https://caselaw.nationalarchives.gov.uk/atom.xml?page=2",
  );
  for (const href of [
    "https://example.test/atom.xml",
    "/other.xml",
    ["javascript", "alert(1)"].join(":"),
    "https://user:pass@caselaw.nationalarchives.gov.uk/atom.xml",
  ]) {
    expect(readUkFclFeed(addLink(href)).isErr()).toBe(true);
  }
});

test("namespace aliases preserve discovery and malformed inputs are rejected", () => {
  const alias = feed
    .replaceAll("xmlns:tna=", "xmlns:source=")
    .replaceAll("tna:", "source:");
  expect(alias).not.toBe(feed);
  expect(readUkFclFeed(alias).unwrap()).toEqual(readUkFclFeed(feed).unwrap());
  for (const raw of [
    feed.slice(0, -20),
    feed.replace("2026-01-03T12:00:00Z", "invalid"),
    feed.replace(/<tna:uri>[^<]+<\/tna:uri>/u, "<tna:uri>../escape</tna:uri>"),
    feed.replace('xmlns="http://www.w3.org/2005/Atom"', 'xmlns="urn:wrong"'),
  ]) {
    expect(readUkFclFeed(raw).isErr()).toBe(true);
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
