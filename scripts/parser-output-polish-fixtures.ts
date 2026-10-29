import { panic } from "better-result";
import { readdir } from "node:fs/promises";
import nodePath from "node:path";

import type {
  DecisionSupplement,
  IngestionResult,
} from "../apps/api/src/handlers/case-law/ingestion/adapter";
import {
  buildPlDecision,
  normalizeSaosDumpItem,
} from "../apps/api/src/handlers/case-law/ingestion/adapters/pl-courts";
import {
  assemblePlKioDecision,
  readPlKioListing,
} from "../apps/api/src/handlers/case-law/ingestion/adapters/pl-kio";
import {
  assemblePlKisDecision,
  plKisRawPartsOf,
  readPlKisListing,
} from "../apps/api/src/handlers/case-law/ingestion/adapters/pl-kis";
import {
  assemblePlNcourtDecision,
  readPlNcourtListing,
} from "../apps/api/src/handlers/case-law/ingestion/adapters/pl-ncourt";
import { assemblePlNsaDecision } from "../apps/api/src/handlers/case-law/ingestion/adapters/pl-nsa";
import { PL_NSA_SNAPSHOT } from "../apps/api/src/handlers/case-law/ingestion/adapters/pl-nsa-dataset";
import {
  assemblePlSnDecision,
  normalizePlSnListingItem,
  readPlSnEnvelope,
} from "../apps/api/src/handlers/case-law/ingestion/adapters/pl-sn";
import {
  assemblePlTkDecision,
  parsePlTkListingPage,
  plTkRawPartsOf,
} from "../apps/api/src/handlers/case-law/ingestion/adapters/pl-tk";
import {
  assemblePlUodoDecision,
  classifyPlUodoRow,
  normalizePlUodoRow,
  plUodoBodyFrom,
  plUodoRawPartsOf,
} from "../apps/api/src/handlers/case-law/ingestion/adapters/pl-uodo";
import {
  assemblePlUokikDecision,
  assemblePlUokikRuling,
  parsePlUokikDetail,
  PL_UOKIK_FILE_STATUS,
  PL_UOKIK_LABEL,
  plUokikRawPartsOf,
} from "../apps/api/src/handlers/case-law/ingestion/adapters/pl-uokik";
import {
  parsePlTkPage,
  readPlTkCasePage,
  readPlTkRuling,
} from "../apps/api/src/handlers/case-law/ingestion/parsers/pl-tk";
import { isRecord } from "../apps/api/src/lib/type-guards";

/** Replay recorded responses through the same pure builders as ingestion. */
type FixtureDecision = IngestionResult | DecisionSupplement;
type AddFixtureOptions = {
  adapter: string;
  fixture: string;
  decision: FixtureDecision;
};
type AddFixture = (options: AddFixtureOptions) => void;
type FixtureFileOptions = { dir: string; name: string };

const createFixtureContext = async (fixtureRoot: string, add: AddFixture) => {
  const root = nodePath.join(
    fixtureRoot,
    "apps/api/src/handlers/case-law/ingestion",
  );
  const adapterDir = nodePath.join(root, "adapters/__fixtures__");
  const parserDir = nodePath.join(root, "parsers/__fixtures__");
  const names = (await readdir(adapterDir))
    .filter((name) => !name.endsWith(".provenance.json"))
    .toSorted();
  const parserNames = (await readdir(parserDir))
    .filter((name) => !name.endsWith(".provenance.json"))
    .toSorted();
  const bytes = async ({ dir, name }: FixtureFileOptions) => {
    const value = await Bun.file(nodePath.join(dir, name)).bytes();
    return name.endsWith(".gz") ? Bun.gunzipSync(value) : value;
  };
  const text = async ({ dir, name }: FixtureFileOptions) =>
    new TextDecoder().decode(await bytes({ dir, name }));
  const json = async ({ dir, name }: FixtureFileOptions): Promise<unknown> =>
    JSON.parse(await text({ dir, name }));
  const rowsFor =
    (adapter: string) => (fixture: string, decision: FixtureDecision) => {
      add({ adapter, fixture, decision });
    };
  return {
    adapterDir,
    parserDir,
    names,
    parserNames,
    bytes,
    text,
    json,
    rowsFor,
  };
};

type FixtureContext = Awaited<ReturnType<typeof createFixtureContext>>;

const collectKio = async ({
  adapterDir,
  names,
  text,
  rowsFor,
}: FixtureContext) => {
  const kio = rowsFor("pl-kio");
  for (const name of names.filter((candidateName) =>
    /^pl-kio-listing-.*\.html$/u.test(candidateName),
  )) {
    const listed =
      readPlKioListing(await text({ dir: adapterDir, name })) ??
      panic(`Invalid listing ${name}`);
    for (const [index, item] of listed.rows.entries()) {
      if (typeof item.id !== "string") {
        panic(`Invalid listing item ${name}:${index}`);
      }
      const detailName = `pl-kio-detail-${item.id}.html`;
      const contentName = `pl-kio-content-${item.id}.html.gz`;
      kio(
        `${name}:${index}`,
        assemblePlKioDecision({
          item,
          detailHtml: names.includes(detailName)
            ? await text({ dir: adapterDir, name: detailName })
            : undefined,
          document: names.includes(contentName)
            ? {
                type: "read",
                html: await text({ dir: adapterDir, name: contentName }),
              }
            : { type: "unavailable" },
        }).decision,
      );
    }
  }
  for (const name of names.filter((candidateName) =>
    /^pl-kio-detail-.*\.html$/u.test(candidateName),
  )) {
    const id = name.slice("pl-kio-detail-".length, -5);
    const contentName = `pl-kio-content-${id}.html.gz`;
    kio(
      name,
      assemblePlKioDecision({
        item: { id },
        detailHtml: await text({ dir: adapterDir, name }),
        document: names.includes(contentName)
          ? {
              type: "read",
              html: await text({ dir: adapterDir, name: contentName }),
            }
          : { type: "unavailable" },
      }).decision,
    );
  }
};

const collectKis = async ({
  adapterDir,
  names,
  bytes,
  text,
  json,
  rowsFor,
}: FixtureContext) => {
  const kis = rowsFor("pl-kis");
  for (const name of names.filter((candidateName) =>
    /^pl-kis-listing-.*\.json$/u.test(candidateName),
  )) {
    const listing =
      readPlKisListing(await json({ dir: adapterDir, name })) ??
      panic(`Invalid listing ${name}`);
    const detail = await text({
      dir: adapterDir,
      name: `${name.replace("listing", "detail")}.gz`,
    });
    for (const [index, row] of listing.rows.entries()) {
      const built = await assemblePlKisDecision({
        row,
        rawParts: plKisRawPartsOf(row, index === 0 ? detail : undefined),
      });
      kis(`${name}:${index}`, built.decision);
      if (index === 0 && name === "pl-kis-listing-05-objas.json") {
        const parsed: unknown = JSON.parse(detail);
        if (
          !isRecord(parsed) ||
          !isRecord(parsed["dokument"]) ||
          !Array.isArray(parsed["dokument"]["fields"])
        ) {
          panic("Invalid pl-kis PDF detail");
        }
        const fields = parsed["dokument"]["fields"].filter(
          (field: unknown) =>
            !isRecord(field) || field["key"] !== "TRESC_INTERESARIUSZ",
        );
        const withoutHtml = JSON.stringify({ ...parsed, dokument: { fields } });
        kis(
          "pl-kis-document-05-objas.pdf",
          (
            await assemblePlKisDecision({
              row,
              rawParts: plKisRawPartsOf(row, withoutHtml),
              pdfBytes: await bytes({
                dir: adapterDir,
                name: "pl-kis-document-05-objas.pdf",
              }),
            })
          ).decision,
        );
      }
    }
  }
};

const collectNcourt = async ({
  adapterDir,
  names,
  text,
  rowsFor,
}: FixtureContext) => {
  const ncourt = rowsFor("pl-ncourt");
  for (const name of names.filter((candidateName) =>
    /^pl-ncourt-listing-.*\.xml$/u.test(candidateName),
  )) {
    const listing =
      readPlNcourtListing(await text({ dir: adapterDir, name })) ??
      panic(`Invalid listing ${name}`);
    for (const [index, listingXml] of listing.fragments.entries()) {
      const detailName = names.find(
        (candidate) =>
          candidate.startsWith("pl-ncourt-detail-") &&
          candidate.endsWith(".xml") &&
          listingXml.includes(candidate.slice("pl-ncourt-detail-".length, -4)),
      );
      const contentName =
        detailName === undefined
          ? undefined
          : `${detailName.replace("detail", "content")}.gz`;
      const built = assemblePlNcourtDecision({
        listingXml,
        detailXml:
          detailName === undefined
            ? undefined
            : await text({ dir: adapterDir, name: detailName }),
        contentXml:
          contentName !== undefined && names.includes(contentName)
            ? await text({ dir: adapterDir, name: contentName })
            : undefined,
      });
      if (built.type === "unkeyable") {
        panic(`${name}:${index}: ${built.type}`);
      }
      ncourt(
        `${name}:${index}`,
        built.type === "built" ? built.decision : built.supplement,
      );
    }
  }
  // The parser tests also feed standalone documents a minimal listing context.
  for (const name of names.filter((candidateName) =>
    /^pl-ncourt-content-.*\.xml\.gz$/u.test(candidateName),
  )) {
    const id = name.slice("pl-ncourt-content-".length, -".xml.gz".length);
    const detailName = `pl-ncourt-detail-${id}.xml`;
    const fallbackDetail =
      "pl-ncourt-detail-155020000001003_II_Ca_000236_2018_Uz_2018-03-22_001.xml";
    const built = assemblePlNcourtDecision({
      listingXml: `<judgement><id>${id}</id><signature>I C 1/15</signature><courtId>15502000</courtId></judgement>`,
      detailXml: await text({
        dir: adapterDir,
        name: names.includes(detailName) ? detailName : fallbackDetail,
      }),
      contentXml: await text({ dir: adapterDir, name }),
    });
    if (built.type === "unkeyable") {
      panic(`${name}: unkeyable`);
    }
    ncourt(
      `${name}:minimal-listing-context`,
      built.type === "built" ? built.decision : built.supplement,
    );
  }
};

const collectNsa = async ({ adapterDir, json, rowsFor }: FixtureContext) => {
  const nsa = rowsFor("pl-nsa");
  const recorded = await json({ dir: adapterDir, name: "pl-nsa-rows.json" });
  if (!Array.isArray(recorded)) {
    panic("Invalid pl-nsa rows");
  }
  for (const entry of recorded) {
    if (
      !isRecord(entry) ||
      typeof entry["case"] !== "string" ||
      typeof entry["shard"] !== "number" ||
      typeof entry["row"] !== "number" ||
      !isRecord(entry["values"])
    ) {
      panic("Invalid pl-nsa row");
    }
    const shard =
      PL_NSA_SNAPSHOT.shards[entry["shard"]] ?? panic("Unknown pl-nsa shard");
    nsa(
      entry["case"],
      assemblePlNsaDecision({
        source: entry["values"],
        position: { shard, row: entry["row"] },
        snapshot: PL_NSA_SNAPSHOT,
      }).decision,
    );
  }
};

const collectTk = async ({
  adapterDir,
  parserDir,
  names,
  parserNames,
  text,
  rowsFor,
}: FixtureContext) => {
  const tk = rowsFor("pl-tk");
  for (const name of names.filter((candidateName) =>
    /^pl-tk-listing-.*\.html\.gz$/u.test(candidateName),
  )) {
    const page =
      parsePlTkListingPage(
        await text({ dir: adapterDir, name }),
        name.includes("preliminary") ? "preliminary" : "merits",
      ) ?? panic(`Invalid listing ${name}`);
    for (const [index, row] of page.rows.entries()) {
      const built = assemblePlTkDecision({
        row,
        casePage: undefined,
        rawParts: plTkRawPartsOf(row, undefined),
      });
      if (built.type === "unkeyable") {
        panic(`${name}:${index}: unkeyable`);
      }
      tk(`${name}:${index}`, built.decision);
    }
  }
  for (const name of parserNames.filter((candidateName) =>
    /^pl-tk-case-.*\.html\.gz$/u.test(candidateName),
  )) {
    const casePage = await text({ dir: parserDir, name });
    const parsedPage = parsePlTkPage(casePage);
    const page = readPlTkCasePage(parsedPage) ?? panic(`Invalid case ${name}`);
    for (const documentId of page.rulingIds) {
      const ruling =
        readPlTkRuling(parsedPage, documentId) ??
        panic(`Missing ruling ${name}:${documentId}`);
      const row = {
        stage: name.includes("ts-")
          ? ("preliminary" as const)
          : ("merits" as const),
        documentId,
        caseId: undefined,
        caseNumber: page.record.caseNumber,
        decisionForm: ruling.decisionForm,
        decisionDate: ruling.decisionDate,
        subject: ruling.subject,
        rowHtml: undefined,
        defect: undefined,
      };
      const built = assemblePlTkDecision({
        row,
        casePage,
        rawParts: plTkRawPartsOf(row, casePage),
      });
      if (built.type === "unkeyable") {
        panic(`${name}:${documentId}: unkeyable`);
      }
      tk(`${name}:${documentId}`, built.decision);
    }
  }
};

const collectUodo = async ({
  adapterDir,
  parserDir,
  bytes,
  json,
  rowsFor,
}: FixtureContext) => {
  const uodo = rowsFor("pl-uodo");
  const uodoRows = await json({
    dir: adapterDir,
    name: "pl-uodo-listing-2023.json.gz",
  });
  if (!Array.isArray(uodoRows)) {
    panic("Invalid pl-uodo listing");
  }
  for (const [index, listing] of uodoRows.entries()) {
    if (!isRecord(listing)) {
      panic(`Invalid pl-uodo row ${index}`);
    }
    const row = normalizePlUodoRow(listing);
    if (classifyPlUodoRow(row).type === "skipped") {
      continue;
    }
    const bodyName =
      listing["refid"] === "urn:ndoc:gov:pl:uodo:2022:dkn_5131_45"
        ? "pl-uodo-dkn-5131-45-2022.xml"
        : undefined;
    const body =
      bodyName === undefined
        ? undefined
        : plUodoBodyFrom(row, await bytes({ dir: parserDir, name: bodyName }));
    const built = assemblePlUodoDecision({
      row,
      body,
      rawParts: plUodoRawPartsOf(listing, body),
    });
    if (built.type !== "built" && built.type !== "detail-unavailable") {
      panic(`pl-uodo:${index}: ${built.type}`);
    }
    uodo(`pl-uodo-listing-2023.json.gz:${index}`, built.decision);
    if (bodyName !== undefined) {
      const alternateBodyName = "pl-uodo-zsoss-440-82-2019.xml";
      const alternateBody = plUodoBodyFrom(
        row,
        await bytes({ dir: parserDir, name: alternateBodyName }),
      );
      const alternate = assemblePlUodoDecision({
        row,
        body: alternateBody,
        rawParts: plUodoRawPartsOf(listing, alternateBody),
      });
      if (
        alternate.type !== "built" &&
        alternate.type !== "detail-unavailable"
      ) {
        panic(`${alternateBodyName}: ${alternate.type}`);
      }
      uodo(`${alternateBodyName}:recorded-listing-context`, alternate.decision);
    }
  }
};

const collectUokik = async ({
  adapterDir,
  parserDir,
  names,
  bytes,
  text,
  json,
  rowsFor,
}: FixtureContext) => {
  const uokik = rowsFor("pl-uokik");
  for (const name of names.filter((candidateName) =>
    /^pl-uokik-view-.*\.json(?:\.gz)?$/u.test(candidateName),
  )) {
    const view = await json({ dir: adapterDir, name });
    if (!isRecord(view) || !Array.isArray(view["viewentry"])) {
      panic(`Invalid view ${name}`);
    }
    for (const [index, entry] of view["viewentry"].entries()) {
      if (!isRecord(entry) || typeof entry["@unid"] !== "string") {
        panic(`Invalid view entry ${name}:${index}`);
      }
      const detailName = `pl-uokik-detail-${entry["@unid"].toLowerCase()}.html`;
      const page = names.includes(detailName)
        ? await text({ dir: adapterDir, name: detailName })
        : undefined;
      const detail = page === undefined ? undefined : parsePlUokikDetail(page);
      const file = detail?.fields
        .find(({ label }) => label === "Decyzja")
        ?.files.at(0);
      const pdfFixtures = new Map([
        ["2520D55B0F17A317C1257EC6007B9773", "pl-uokik-dok-9-2011.pdf"],
        ["71C0A3DFE2EB6946C1258BF0003D546A", "pl-uokik-rgd-16-2024.pdf"],
      ]);
      const pdf = pdfFixtures.get(entry["@unid"].toUpperCase());
      const files =
        file === undefined || pdf === undefined
          ? []
          : [
              {
                name: file.name,
                status: PL_UOKIK_FILE_STATUS.READ,
                bytes: await bytes({ dir: parserDir, name: pdf }),
              },
            ];
      const built = await assemblePlUokikDecision({
        entry,
        rawParts: plUokikRawPartsOf(entry, page),
        files,
      });
      if (built.type === "unkeyable") {
        panic(`${name}:${index}: unkeyable`);
      }
      const sourceDocumentId =
        built.decision.sourceDocumentId ??
        panic(`${name}:${index}: missing source document ID`);
      uokik(`${name}:${index}`, built.decision);
      if (
        page !== undefined &&
        detail !== undefined &&
        detail !== null &&
        entry["@unid"].toUpperCase() === "E1054A6198F37B72C1257EC6007B8007"
      ) {
        const rulingFixtures: Record<string, string> = {
          "Wyrok VI ACa 527_08.pdf": "pl-uokik-ruling-vi-aca-527-08.pdf",
          "Postanowienie III SK 17_09.pdf": "pl-uokik-ruling-iii-sk-17-09.pdf",
          "Wyrok XVII AmA 73_07.pdf": "pl-uokik-ruling-xvii-ama-73-07.pdf",
        };
        const rulingFiles =
          detail.fields.find(({ label }) => label === PL_UOKIK_LABEL.RULINGS)
            ?.files ?? panic("Missing pl-uokik rulings");
        for (const rulingFile of rulingFiles) {
          const fixtureName =
            rulingFixtures[rulingFile.name] ??
            panic(`Missing ruling fixture ${rulingFile.name}`);
          uokik(
            fixtureName,
            await assemblePlUokikRuling({
              entry,
              detailHtml: page,
              unid: entry["@unid"],
              file: rulingFile,
              fetched: {
                name: rulingFile.name,
                status: PL_UOKIK_FILE_STATUS.READ,
                bytes: await bytes({ dir: parserDir, name: fixtureName }),
              },
              decision: {
                sourceDocumentId,
                caseNumber: built.decision.caseNumber,
                decisionDate: built.decision.decisionDate,
              },
            }),
          );
        }
      }
    }
  }
};

const collectCourts = async ({ adapterDir, json, rowsFor }: FixtureContext) => {
  const store = rowsFor("pl-courts");
  const details = new Map<unknown, Record<string, unknown>>();
  for (const name of [
    "pl-courts-detail-common.json.gz",
    "pl-courts-detail-chamber.json.gz",
    "pl-courts-detail-303939.json.gz",
    "pl-courts-detail-472699.json.gz",
    "pl-courts-detail-501501.json.gz",
    "pl-courts-detail-628.json.gz",
    "pl-courts-detail-summary-brak.json.gz",
    "pl-courts-detail-summary-nietezowane.json.gz",
  ]) {
    const payload = await json({ dir: adapterDir, name });
    if (!isRecord(payload) || !isRecord(payload["data"])) {
      panic(`${name}: invalid SAOS detail`);
    }
    const detail = payload["data"];
    details.set(detail["id"], detail);
    const decision =
      buildPlDecision({
        listingItem: normalizeSaosDumpItem({ id: detail["id"] }),
        detail: normalizeSaosDumpItem(detail),
        rawParts: {
          "listing-dump": JSON.stringify({ id: detail["id"] }),
          detail: JSON.stringify(payload),
        },
      }) ?? panic(`${name}: no decision`);
    store(name, decision);
  }
  for (const name of [
    "pl-courts-dump-day.json.gz",
    "pl-courts-search-day.json.gz",
  ]) {
    const payload = await json({ dir: adapterDir, name });
    if (!isRecord(payload) || !Array.isArray(payload["items"])) {
      panic(`${name}: invalid SAOS listing`);
    }
    for (const [index, row] of payload["items"].entries()) {
      if (!isRecord(row)) {
        panic(`${name}:${index}: invalid SAOS row`);
      }
      const detail = details.get(row["id"]);
      const listingPart = name.includes("dump")
        ? "listing-dump"
        : "listing-search";
      const decision =
        buildPlDecision({
          listingItem: normalizeSaosDumpItem(row),
          detail: detail === undefined ? null : normalizeSaosDumpItem(detail),
          rawParts: {
            [listingPart]: JSON.stringify(row),
            ...(detail === undefined
              ? {}
              : { detail: JSON.stringify({ data: detail }) }),
          },
        }) ?? panic(`${name}:${index}: no decision`);
      store(`${name}:${index}`, decision);
    }
  }
};

const collectSnListings = async ({
  adapterDir,
  names,
  json,
  rowsFor,
}: FixtureContext) => {
  const store = rowsFor("pl-sn");
  for (const name of names.filter((candidate) =>
    /^pl-sn-listing-.*\.json$/u.test(candidate),
  )) {
    const payload = readPlSnEnvelope(await json({ dir: adapterDir, name }));
    if (!Array.isArray(payload)) {
      panic(`${name}: invalid Supreme Court listing`);
    }
    for (const [index, row] of payload.entries()) {
      if (!isRecord(row)) {
        panic(`${name}:${index}: invalid Supreme Court row`);
      }
      const built = await assemblePlSnDecision({
        item: normalizePlSnListingItem(row),
        detail: null,
        documentBytes: undefined,
        rawParts: { listing: JSON.stringify(row) },
      });
      if (built.type === "unkeyable") {
        panic(`${name}:${index}: unkeyable Supreme Court row`);
      }
      store(`${name}:${index}`, built.decision);
    }
  }
};

export const collectPolishFixtures = async (
  fixtureRoot: string,
  add: AddFixture,
) => {
  const context = await createFixtureContext(fixtureRoot, add);
  await collectKio(context);
  await collectKis(context);
  await collectNcourt(context);
  await collectNsa(context);
  await collectTk(context);
  await collectUodo(context);
  await collectUokik(context);
  await collectCourts(context);
  await collectSnListings(context);
};
