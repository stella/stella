/**
 * What this adapter does with the record its publisher serves.
 *
 * The service publishes its own OpenAPI document, so the field list is not
 * something an implementer infers from a sample: it is declared, and the
 * first suite below diffs the inventory against it. A field the ministry adds
 * to `Rozhodnutie` therefore fails here by name, on the schema, rather than
 * waiting for someone to notice a value arriving on a response the crawl
 * already pays for and going nowhere — which is how `oblast`, `povodnySud`
 * and `povodnaSpisovaZnacka` were fetched and discarded for years.
 *
 * The rest drive a decision the crawl actually stored: the committed page
 * recording holds real records, so the assertions about where a field lands
 * are made against what the publisher sent rather than against a payload
 * written to match the code.
 */

import { PDF } from "@libpdf/core";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  StoredRawReader,
  StoredRawReparseOutcome,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  skCourtsAdapter,
  SK_COURTS_SOURCE_FIELD_PATHS,
} from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { readGzipJson } from "@/api/lib/gzip-json";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const FIXTURES_DIR = new URL("__fixtures__/", import.meta.url);

// ── The publisher's own schema ───────────────────────────

/** The decision schema of the captured OpenAPI document, and its components. */
type SchemaComponents = Readonly<Record<string, unknown>>;

const schemaComponentsOf = (document: unknown): SchemaComponents => {
  const components = isRecord(document) ? document["components"] : undefined;
  const schemas = isRecord(components) ? components["schemas"] : undefined;
  return isRecord(schemas)
    ? schemas
    : panic("the captured OpenAPI document declares no component schemas");
};

/** A `$ref` followed to the component it names. */
const dereference = (node: unknown, schemas: SchemaComponents): unknown => {
  if (!isRecord(node)) {
    return node;
  }
  const reference = node["$ref"];
  if (typeof reference !== "string") {
    return node;
  }
  const name = reference.split("/").at(-1) ?? "";
  return (
    schemas[name] ?? panic(`the schema references an absent component: ${name}`)
  );
};

/**
 * Every property path one schema declares, spelled the way the adapter's
 * inventory spells them: an object contributes its leaves, and a list of
 * objects contributes `parent[].child`.
 */
const declaredPropertyPaths = (
  node: unknown,
  path: string,
  schemas: SchemaComponents,
): readonly string[] => {
  const resolved = dereference(node, schemas);
  if (!isRecord(resolved)) {
    return [path];
  }
  const properties = resolved["properties"];
  if (isRecord(properties)) {
    return Object.entries(properties).flatMap(([name, property]) =>
      declaredPropertyPaths(
        property,
        path === "" ? name : `${path}.${name}`,
        schemas,
      ),
    );
  }
  const items = resolved["items"];
  if (resolved["type"] === "array" && items !== undefined) {
    const element = dereference(items, schemas);
    return isRecord(element) && isRecord(element["properties"])
      ? declaredPropertyPaths(items, `${path}[]`, schemas)
      : [path];
  }
  return [path];
};

describe("the inventory is keyed on the schema the service publishes", () => {
  test("it decides about every path `Rozhodnutie` declares, and no other", async () => {
    const schemas = schemaComponentsOf(
      await readGzipJson(new URL("sk-courts-openapi.json.gz", FIXTURES_DIR)),
    );
    const declared = [
      ...declaredPropertyPaths(schemas["Rozhodnutie"], "", schemas),
    ].toSorted();
    const decided = [...SK_COURTS_SOURCE_FIELD_PATHS].toSorted();

    const undecided = declared.filter((path) => !decided.includes(path));
    const invented = decided.filter((path) => !declared.includes(path));

    expect(
      undecided,
      `the service declares these and the inventory decides nothing about them: ${undecided.join(", ")}.`,
    ).toEqual([]);
    expect(
      invented,
      `the inventory decides about these and the service declares no such path: ${invented.join(", ")}. Recapture the schema, or fix the spelling.`,
    ).toEqual([]);
  });

  test("the listing row's schema is a subset of the record's", async () => {
    const schemas = schemaComponentsOf(
      await readGzipJson(new URL("sk-courts-openapi.json.gz", FIXTURES_DIR)),
    );
    const listing = declaredPropertyPaths(
      schemas["BaseRozhodnutie"],
      "",
      schemas,
    );
    const record = declaredPropertyPaths(schemas["Rozhodnutie"], "", schemas);

    // Keying the inventory on the record alone is only total over both pages
    // because of this: a property the listing states and the record does not
    // would be a field nothing decided about.
    expect(listing.filter((path) => !record.includes(path))).toEqual([]);
  });
});

// ── A record the crawl stored ────────────────────────────

/**
 * The transferred-file decision of the committed page recording.
 *
 * Selected by the publisher's own id rather than by docket or position. The
 * docket would not do: this recording holds two decisions of one case under
 * `7C/221/1991`, six years and one ECLI ordinal apart, which is the same
 * reason the row is keyed on `guid` rather than on the number a court printed
 * on it.
 *
 * It is the row that states the legal area, the transferring court and the
 * docket that court opened the file under — the three the adapter used to
 * fetch and discard. It is also the row where the two responses disagree: the
 * listing carries the pre-transfer docket and court (`7C/221/1991`, `Okresný
 * súd Bratislava I`) and the record the post-transfer ones
 * (`B1-7C/221/1991`, `Mestský súd Bratislava IV`), so which response a field
 * is read from decides what the row says. The adapter keys on the listing,
 * because that is the response the crawl enumerates and reconciles against.
 */
const TRANSFERRED_FILE_ID =
  "23ea32af-a671-41a6-b853-72f5d52b820c:26b85db6-ff6b-44ff-8fa4-a21c89805371";

const TRANSFERRED_FILE_DOCKET = "7C/221/1991";

type StoredDecision = {
  sourceRaw: string;
  sourceRawContentType: string;
  readBinary?: StoredRawReader;
};

const storedDecision = async (
  sourceDocumentId: string,
): Promise<StoredDecision> => {
  const recording = await readGzipJson(
    new URL("sk-courts-page.json.gz", FIXTURES_DIR),
  );
  const page = isRecord(recording) ? recording["page"] : undefined;
  const decisions = isRecord(page) ? page["decisions"] : undefined;
  const found = isUnknownArray(decisions)
    ? decisions.find(
        (decision) =>
          isRecord(decision) &&
          decision["sourceDocumentId"] === sourceDocumentId,
      )
    : undefined;
  if (
    !isRecord(found) ||
    typeof found["sourceRaw"] !== "string" ||
    typeof found["sourceRawContentType"] !== "string"
  ) {
    return panic(`the page recording holds no decision ${sourceDocumentId}`);
  }
  return {
    sourceRaw: found["sourceRaw"],
    sourceRawContentType: found["sourceRawContentType"],
  };
};

const reparse = async (
  stored: StoredDecision,
  caseNumber: string,
): Promise<StoredRawReparseOutcome> => {
  const outcome = await skCourtsAdapter.reparseStoredRaw?.({
    readBinary: stored.readBinary,
    raw: new TextEncoder().encode(stored.sourceRaw),
    contentType: stored.sourceRawContentType,
    caseNumber,
    sourceDocumentId: null,
    language: "sk",
    court: "",
    ecli: null,
    decisionDate: null,
    decisionType: null,
    sourceUrl: null,
    documentUrl: null,
    metadata: {},
  });
  if (outcome === undefined) {
    return panic("sk-courts declares no reparseStoredRaw");
  }
  return outcome;
};

describe("a stored record reaches the targets the inventory declares", () => {
  test("the rows written before the envelope are still readable", async () => {
    const stored = await storedDecision(TRANSFERRED_FILE_ID);

    // The shape this adapter wrote for several million rows: one JSON object
    // wrapping the two responses under its own key names.
    expect(stored.sourceRawContentType).toBe("application/json");
    expect(decodeSourceRawEnvelope(stored.sourceRaw)).toBeNull();

    const outcome = await reparse(stored, TRANSFERRED_FILE_DOCKET);

    expect(outcome.type).toBe("parsed");
  });

  test("the three fields the adapter used to discard land in metadata", async () => {
    const outcome = await reparse(
      await storedDecision(TRANSFERRED_FILE_ID),
      TRANSFERRED_FILE_DOCKET,
    );
    if (outcome.type !== "parsed") {
      throw new Error(
        `the stored record did not re-parse: ${outcome.type === "rejected" ? outcome.detail : outcome.type}`,
      );
    }
    const { metadata } = outcome.result;

    expect(metadata["area"]).toEqual(["Občianske právo"]);
    expect(metadata["originCourt"]).toBe("Mestský súd Bratislava I");
    expect(metadata["originCourtRegistreGuid"]).toBe("sud_102");
    // The docket the file was opened under, beside the prefixed one the
    // receiving court renumbered it to. A citation names the first, and
    // before this the row held neither the name nor the number.
    expect(metadata["originCaseNumber"]).toBe("7C/221/1991");
    expect(outcome.result.caseNumber).toBe(TRANSFERRED_FILE_DOCKET);
  });

  test("the record's other labelled fields keep their targets", async () => {
    const outcome = await reparse(
      await storedDecision(TRANSFERRED_FILE_ID),
      TRANSFERRED_FILE_DOCKET,
    );
    if (outcome.type !== "parsed") {
      throw new Error(
        `the stored record did not re-parse: ${outcome.type === "rejected" ? outcome.detail : outcome.type}`,
      );
    }
    const { metadata } = outcome.result;

    expect(outcome.result.ecli).toBe("ECLI:SK:OSBA1:1997:1191896318.4");
    expect(outcome.result.court).toBe("Okresný súd Bratislava I");
    expect(outcome.result.decisionDate).toBe("1997-06-20");
    expect(outcome.result.decisionType).toBe("Rozsudok");
    expect(metadata["identifikacneCislo"]).toBe("1191896318");
    expect(metadata["subArea"]).toEqual(["Ostatné"]);
    expect(metadata["decisionNature"]).toEqual(["Zmeňujúce"]);
    expect(metadata["documentName"]).toBe("Rozsudok_7C-221-1991.pdf");
    expect(metadata["documentExtension"]).toBe("PDF");
    expect(metadata["documentSize"]).toBe(95_553);
    expect(metadata["updateDate"]).toBe("26.09.2023");
    // The name is the judge's or a senior court officer's and the record says
    // which nowhere, so it stays a stated name rather than a bench role.
    expect(metadata["judge"]).toBe("JUDr. Anton Mihalovits");
    expect(outcome.result.judges).toBeUndefined();
  });

  test("re-parsing preserves the originally captured raw bytes", async () => {
    const stored = await storedDecision(TRANSFERRED_FILE_ID);
    const outcome = await reparse(stored, TRANSFERRED_FILE_DOCKET);
    if (outcome.type !== "parsed") {
      return panic("The stored listing did not parse");
    }
    expect(outcome.result.sourceRawContentType).toBe(
      stored.sourceRawContentType,
    );
    expect(outcome.result.sourceRawBytes).toEqual(
      new TextEncoder().encode(stored.sourceRaw),
    );
  });

  test("a payload naming another decision is refused", async () => {
    const outcome = await reparse(
      await storedDecision(TRANSFERRED_FILE_ID),
      "9C/1/2026",
    );

    expect(outcome).toMatchObject({
      type: "rejected",
      rejection: "identity-mismatch",
    });
  });

  test("a payload this adapter never wrote is refused, not guessed at", async () => {
    const outcome = await reparse(
      { sourceRaw: "<html></html>", sourceRawContentType: "text/html" },
      TRANSFERRED_FILE_DOCKET,
    );

    expect(outcome).toMatchObject({
      type: "rejected",
      rejection: "unsupported-content",
    });
  });
});

describe("the census and the registry agree about this adapter", () => {
  test("its recorded surfaces include the retained document file", () => {
    const { surfaces } = skCourtsAdapter.sourceSurfaces;
    const recorded = Object.entries(surfaces).flatMap(([, disposition]) =>
      disposition.disposition === "stored" ? [disposition.part] : [],
    );

    expect(recorded.toSorted()).toEqual(["detail", "document-file", "listing"]);
  });

  test("the surfaces still on the backlog name why", () => {
    const { surfaces } = skCourtsAdapter.sourceSurfaces;
    const backlog = Object.entries(surfaces).flatMap(
      ([surface, disposition]) =>
        disposition.disposition === "backlog" ? [surface] : [],
    );

    expect(backlog.toSorted()).toEqual(["bulk-dump"]);
    expect(skCourtsAdapter.key).toBe(ADAPTER_KEYS.SK_COURTS);
  });
});

type StoredPdfOptions = { bytes: Uint8Array; readBinary?: StoredRawReader };
const storedPdf = async ({
  bytes,
  readBinary,
}: StoredPdfOptions): Promise<StoredDecision> => {
  const original = await storedDecision(TRANSFERRED_FILE_ID);
  const wrapper: unknown = JSON.parse(original.sourceRaw);
  if (
    !isRecord(wrapper) ||
    !isRecord(wrapper["listItem"]) ||
    !isRecord(wrapper["detail"])
  ) {
    return panic("Captured legacy listing wrapper has changed");
  }
  return {
    sourceRaw: encodeSourceRawEnvelope(
      {
        listing: JSON.stringify(wrapper["listItem"]),
        detail: JSON.stringify(wrapper["detail"]),
      },
      {
        "document-file": {
          location: "captured/sk/document.pdf",
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          byteLength: bytes.byteLength,
          contentType: "application/pdf",
        },
      },
    ),
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    readBinary,
  };
};

describe("stored PDF replay without publisher requests", () => {
  test("verified PDF restores content and preserves listing metadata and exact raw envelope", async () => {
    const pdf = PDF.create();
    pdf
      .addPage()
      .drawText("Stored ruling text retained for replay.", { x: 40, y: 500 });
    const bytes = await pdf.save();
    const reads: string[] = [];
    const captured = await storedPdf({
      bytes,
      readBinary: async (key) => {
        reads.push(key);
        return bytes;
      },
    });
    const outcome = await reparse(captured, TRANSFERRED_FILE_DOCKET);
    expect(outcome.type).toBe("parsed");
    if (outcome.type !== "parsed") {
      return panic("Verified PDF did not replay");
    }
    expect(reads).toEqual(["captured/sk/document.pdf"]);
    expect(outcome.result.fulltext).toContain(
      "Stored ruling text retained for replay.",
    );
    if (!("blocks" in outcome.result.documentAst)) {
      return panic("Verified PDF replay produced no document AST");
    }
    expect(outcome.result.documentAst.blocks.length).toBeGreaterThan(0);
    expect(outcome.result.sections?.length).toBeGreaterThan(0);
    expect(outcome.result.metadata["originCaseNumber"]).toBe("7C/221/1991");
    expect(outcome.result.documentDelivery).toBe("inline");
    expect(outcome.result.sourceRawBytes).toEqual(
      new TextEncoder().encode(captured.sourceRaw),
    );
  });

  test("absent reader, missing object and mismatched bytes yield explicit failures", async () => {
    const bytes = new TextEncoder().encode("captured PDF bytes");
    const unavailable = await reparse(
      await storedPdf({ bytes }),
      TRANSFERRED_FILE_DOCKET,
    );
    expect(unavailable).toMatchObject({
      type: "rejected",
      rejection: "unsupported-content",
    });
    const missing = await reparse(
      await storedPdf({ bytes, readBinary: async () => null }),
      TRANSFERRED_FILE_DOCKET,
    );
    expect(missing).toMatchObject({
      type: "rejected",
      rejection: "no-document",
    });
    const changed = await reparse(
      await storedPdf({
        bytes,
        readBinary: async () => new TextEncoder().encode("altered PDF bytes!"),
      }),
      TRANSFERRED_FILE_DOCKET,
    );
    expect(changed).toMatchObject({
      type: "rejected",
      rejection: "raw-fidelity-lost",
    });
  });

  test("malformed object references cannot become metadata-only success", async () => {
    const captured = await storedPdf({ bytes: Uint8Array.of(1) });
    const envelope: unknown = JSON.parse(captured.sourceRaw);
    if (!isRecord(envelope)) {
      return panic("Stored PDF fixture is not an envelope");
    }
    const malformed = await reparse(
      {
        sourceRaw: JSON.stringify({
          version: 1,
          parts: envelope["parts"],
          objects: { "document-file": { location: "missing-fields" } },
        }),
        sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      },
      TRANSFERRED_FILE_DOCKET,
    );
    expect(malformed).toMatchObject({
      type: "rejected",
      rejection: "raw-fidelity-lost",
    });
  });
});
