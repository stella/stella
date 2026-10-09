import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import {
  registryString,
  registryExtras,
  expectRegistryOutcome,
  expectRegistryResponses,
  forEachRegistryMutation,
  expectNullableString,
} from "../shared/property-test-helpers.test.js";
import { lookupFullRecordByIco, searchByName } from "./client.js";
import {
  parseExtract,
  parseSearchHit,
  parseHistory,
  parseDocument,
  parseRelatedHit,
} from "./parse.js";
import type {
  OrsrRawExtractResponse,
  OrsrRawDocument,
  OrsrRawRelatedHit,
} from "./types.js";

const temporalValue = fc.record(
  {
    value: registryString,
    current: fc.boolean(),
    effectiveFrom: registryString,
    effectiveTo: registryString,
  },
  { requiredKeys: [] },
);
const reference = fc.record(
  {
    section: registryString,
    court: registryString,
    insertNumber: fc.oneof(registryString, fc.integer()),
  },
  { requiredKeys: [] },
);
const personData = fc.record(
  {
    corporateBody: fc.record(
      { corporateBodyFullName: registryString },
      { requiredKeys: [] },
    ),
    physicalPerson: fc.record(
      {
        personName: fc.record(
          { formattedName: registryString },
          { requiredKeys: [] },
        ),
      },
      { requiredKeys: [] },
    ),
    id: fc.array(
      fc.record({ identifierValue: registryString }, { requiredKeys: [] }),
      { maxLength: 3 },
    ),
  },
  { requiredKeys: [] },
);
const member = fc.record(
  {
    personData,
    stakeholderType: fc.record(
      {
        item: fc.record(
          {
            codelistItem: fc.record(
              { itemCode: registryString, itemName: registryString },
              { requiredKeys: [] },
            ),
          },
          { requiredKeys: [] },
        ),
      },
      { requiredKeys: [] },
    ),
    current: fc.boolean(),
    effectiveFrom: registryString,
    effectiveTo: registryString,
    function: registryString,
    functionCreationDate: registryString,
    functionTerminationDate: registryString,
  },
  { requiredKeys: [] },
);
const extract = fc
  .record(
    {
      fileReference: reference,
      courtName: registryString,
      legalPerson: fc.record(
        {
          id: fc.array(
            fc.record(
              { identifierValue: registryString },
              { requiredKeys: [] },
            ),
            { maxLength: 4 },
          ),
          corporateBody: fc.record(
            {
              corporateBodyFullName: fc.array(temporalValue, { maxLength: 4 }),
              termination: registryString,
              establishment: registryString,
              authorizationToExecute: fc.array(temporalValue, { maxLength: 4 }),
              statutoryBody: fc.array(member, { maxLength: 3 }),
              stakeholder: fc.array(member, { maxLength: 3 }),
              statutoryBodyType: fc.array(temporalValue, { maxLength: 3 }),
            },
            { requiredKeys: [] },
          ),
        },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: [] },
  )
  .map((raw) => raw satisfies OrsrRawExtractResponse);
const normalizedName = (value: string | undefined) =>
  value
    ? value.replaceAll(/\s+/gu, " ").trim().replaceAll(/^"|"$/gu, "")
    : null;

test(
  "extract and history preserve selected source identity and temporal provenance",
  () => {
    fc.assert(
      fc.property(extract, registryExtras, (raw, extras) => {
        const enriched = { extraFields: extras, ...raw };
        const parsed = expectRegistryOutcome(() => parseExtract(enriched));
        const history = expectRegistryOutcome(() => parseHistory(enriched));
        if (parsed) {
          expect(
            raw.legalPerson?.id?.some(
              (row) => row.identifierValue === parsed.ico,
            ),
          ).toBe(true);
          expect(
            raw.legalPerson?.corporateBody?.corporateBodyFullName?.some(
              (row) => normalizedName(row.value) === parsed.name,
            ),
          ).toBe(true);
          if (parsed.courtFile) {
            expect(raw.fileReference?.section).toBe(parsed.courtFile.section);
            expect(raw.fileReference?.court).toBe(parsed.courtFile.court);
            expect(parsed.courtFile.insertNumber).toBe(
              String(raw.fileReference?.insertNumber),
            );
            expect(parsed.registryUrl).toContain(
              encodeURIComponent(parsed.courtFile.section.toWellFormed()),
            );
          }
          for (const stakeholder of parsed.stakeholders) {
            expect(typeof stakeholder.position).toBe("string");
            expect(typeof stakeholder.organName).toBe("string");
            expect(stakeholder.name.length).toBeGreaterThan(0);
          }
          for (const body of parsed.statutoryBodies) {
            for (const bodyMember of body.members) {
              expect(bodyMember.name.length).toBeGreaterThan(0);
            }
          }
        }
        if (!history) {
          return;
        }
        for (const entry of history) {
          expect(entry.validTo).not.toBeNull();
          if ("value" in entry) {
            expect(entry.value.length).toBeGreaterThan(0);
          } else {
            expect(entry.name.length).toBeGreaterThan(0);
          }
        }
        for (let i = 1; i < history.length; i++) {
          const previous = history.at(i - 1);
          const current = history.at(i);
          if (previous && current) {
            expect(
              // oxlint-disable-next-line require-cached-collator/require-cached-collator -- The property oracle mirrors the parser runtime-default ordering contract.
              (previous.validTo ?? "").localeCompare(current.validTo ?? ""),
            ).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

const document = fc
  .record(
    {
      serialNumber: fc.integer(),
      name: registryString,
      type: fc.integer(),
      deliveryDate: registryString,
      pageCount: fc.integer(),
      isElectronic: fc.boolean(),
    },
    { requiredKeys: [] },
  )
  .map((raw) => raw satisfies OrsrRawDocument);
const related = fc
  .record(
    {
      corporateBodyFullName: registryString,
      registrationNumber: registryString,
      physicalAddressLine1: registryString,
      physicalAddressLine2: registryString,
      relatedPersonName: registryString,
      fileReference: reference,
    },
    { requiredKeys: [] },
  )
  .map((raw) => raw satisfies OrsrRawRelatedHit);

test(
  "documents and related search retain normalized names and reference atoms",
  () => {
    fc.assert(
      fc.property(
        document,
        related,
        registryExtras,
        (rawDocument, rawRelated, extras) => {
          const enrichedDocument = { extraFields: extras, ...rawDocument };
          const enrichedRelated = { extraFields: extras, ...rawRelated };
          const enrichedSearch = { ...enrichedRelated, id: 0 };
          const parsedDocument = expectRegistryOutcome(() =>
            parseDocument(enrichedDocument),
          );
          if (parsedDocument) {
            expect(rawDocument.serialNumber).toBe(parsedDocument.serialNumber);
            expect(normalizedName(rawDocument.name)).toBe(parsedDocument.name);
            expect(parsedDocument.medium).toBe(
              rawDocument.isElectronic === true ? "electronic" : "paper",
            );
          } else if (parsedDocument === null) {
            expect(
              rawDocument.serialNumber === undefined ||
                !normalizedName(rawDocument.name),
            ).toBe(true);
          }
          const parsedRelated = expectRegistryOutcome(() =>
            parseRelatedHit(enrichedRelated),
          );
          const search = expectRegistryOutcome(() =>
            parseSearchHit(enrichedSearch),
          );
          if (parsedRelated) {
            expect(normalizedName(rawRelated.corporateBodyFullName)).toBe(
              parsedRelated.name,
            );
            expect(parsedRelated.ico).toBe(
              rawRelated.registrationNumber?.trim() || null,
            );
            expect(search?.name).toBe(parsedRelated.name);
            expect(search?.address).toBe(parsedRelated.address);
            if (parsedRelated.fileReference) {
              expect({
                section: rawRelated.fileReference?.section,
                court: rawRelated.fileReference?.court,
                insertNumber: String(rawRelated.fileReference?.insertNumber),
              }).toEqual(parsedRelated.fileReference);
            }
            expectNullableString(parsedRelated.connectedThrough);
          } else if (parsedRelated === null) {
            expect(
              normalizedName(rawRelated.corporateBodyFullName) || null,
            ).toBeNull();
          }
        },
      ),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "current nested records retain identity and stakeholder role strings",
  () => {
    fc.assert(
      fc.property(
        registryString,
        registryString,
        registryString,
        registryString,
        reference,
        (ico, name, roleCode, roleName, fileReference) => {
          const raw = {
            fileReference,
            legalPerson: {
              id: [{ identifierValue: ico }],
              corporateBody: {
                corporateBodyFullName: [{ value: name, current: true }],
                stakeholder: [
                  {
                    current: true,
                    personData: {
                      corporateBody: { corporateBodyFullName: name },
                    },
                    stakeholderType: {
                      item: {
                        codelistItem: {
                          itemCode: roleCode,
                          itemName: roleName,
                        },
                      },
                    },
                  },
                ],
              },
            },
          } satisfies OrsrRawExtractResponse;
          const parsed = expectRegistryOutcome(() => parseExtract(raw));
          if (parsed === undefined) {
            return;
          }
          const normalized = normalizedName(name);
          if (!ico || !normalized) {
            expect(parsed).toBeNull();
            return;
          }
          expect(parsed?.ico).toBe(ico);
          expect(parsed?.name).toBe(normalized);
          expect(parsed?.stakeholders.length).toBe(1);
          const stakeholder = parsed?.stakeholders.at(0);
          expect(stakeholder?.name).toBe(normalized);
          expect(typeof stakeholder?.position).toBe("string");
          expect(typeof stakeholder?.organName).toBe("string");
        },
      ),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

const endpointForUrl = (url: string) => {
  const path = new URL(url).pathname;
  if (path.endsWith("/extract-full")) {
    return "history";
  }
  if (path.endsWith("/extract")) {
    return "extract";
  }
  if (path.endsWith("/documents")) {
    return "documents";
  }
  if (path.endsWith("/related")) {
    return "related";
  }
  return "search";
};

test.each(["search", "extract", "history", "documents", "related"] as const)(
  "%s response fields yield domain values, typed errors or unavailable parts",
  async (kind) => {
    const payloads: Record<string, unknown> = {};
    for (const [key, filename] of Object.entries({
      search: "search-by-ico-eset",
      extract: "extract-eset",
      history: "extract-full-eset",
      documents: "documents-eset",
      related: "related-empty",
    })) {
      payloads[key] = await Bun.file(
        new URL(`__fixtures__/${filename}.json`, import.meta.url),
      ).json();
    }
    const baseline = await expectRegistryResponses(
      (url) => {
        const endpoint = endpointForUrl(url);
        return payloads[endpoint];
      },
      async () => lookupFullRecordByIco("31333532", { observer: "unobserved" }),
    );
    expect(baseline?.company.ico).toBe("31333532");
    expect(baseline?.history.status).toBe("loaded");
    expect(baseline?.documents.status).toBe("loaded");
    expect(baseline?.related.status).toBe("loaded");
    const original =
      kind === "related"
        ? {
            data: [
              {
                corporateBodyFullName: "Related",
                registrationNumber: "31333532",
                relatedPersonName: "Person",
                physicalAddressLine1: "Street",
                fileReference: {
                  section: "Sro",
                  insertNumber: "3586",
                  court: "B",
                },
              } satisfies OrsrRawRelatedHit,
            ],
          }
        : payloads[kind];
    await forEachRegistryMutation(original, async (mutated) => {
      const responseOf = (url: string) => {
        const endpoint = endpointForUrl(url);
        return endpoint === kind ? mutated : payloads[endpoint];
      };
      if (kind === "search") {
        const results = await expectRegistryResponses(responseOf, async () =>
          searchByName("ESET", { observer: "unobserved" }),
        );
        if (results) {
          for (const row of results) {
            expect(typeof row.ico).toBe("string");
            expect(typeof row.name).toBe("string");
            expectNullableString(row.address);
          }
        }
        return;
      }
      const record = await expectRegistryResponses(responseOf, async () =>
        lookupFullRecordByIco("31333532", { observer: "unobserved" }),
      );
      if (!record) {
        return;
      }
      expect(record.company.ico).toBe("31333532");
      expect(typeof record.company.name).toBe("string");
      expect(record.company.name.length).toBeGreaterThan(0);
      for (const value of [
        record.company.legalForm,
        record.company.establishedAt,
        record.company.terminatedAt,
        record.company.shareCapital,
        record.company.shareCapitalPaid,
        record.company.actingClause,
      ]) {
        expectNullableString(value);
      }
      if (record.company.address) {
        for (const value of Object.values(record.company.address)) {
          expectNullableString(value);
        }
      }
      if (record.company.courtFile) {
        expect(typeof record.company.courtFile.court).toBe("string");
        expect(typeof record.company.courtFile.section).toBe("string");
        expect(typeof record.company.courtFile.insertNumber).toBe("string");
        expectNullableString(record.company.courtFile.courtName);
      }
      for (const body of record.company.statutoryBodies) {
        for (const bodyMember of body.members) {
          expect(typeof bodyMember.name).toBe("string");
          for (const value of [
            bodyMember.position,
            bodyMember.address,
            bodyMember.since,
          ]) {
            expectNullableString(value);
          }
        }
      }
      for (const stakeholder of record.company.stakeholders) {
        expect(typeof stakeholder.name).toBe("string");
        expect(typeof stakeholder.organName).toBe("string");
        expect(typeof stakeholder.position).toBe("string");
        for (const value of [
          stakeholder.identifier,
          stakeholder.share,
          stakeholder.address,
        ]) {
          expectNullableString(value);
        }
      }
      for (const part of [record.history, record.documents, record.related]) {
        switch (part.status) {
          case "unavailable":
            expect(part.reason.length).toBeGreaterThan(0);
            break;
          case "loaded":
            expect(Array.isArray(part.value)).toBe(true);
            break;
          default:
            part satisfies never;
        }
      }
      if (record.documents.status === "loaded") {
        for (const row of record.documents.value) {
          expect(typeof row.name).toBe("string");
          expect(typeof row.serialNumber).toBe("number");
          expectNullableString(row.deliveredOn);
          expect(
            row.pageCount === null || typeof row.pageCount === "number",
          ).toBe(true);
          expect(
            row.typeCode === null || typeof row.typeCode === "number",
          ).toBe(true);
          expect(["paper", "electronic"]).toContain(row.medium);
        }
      }
      if (record.related.status === "loaded") {
        for (const row of record.related.value) {
          expect(typeof row.name).toBe("string");
          expectNullableString(row.ico);
          expectNullableString(row.address);
          expectNullableString(row.connectedThrough);
          if (row.fileReference) {
            for (const value of Object.values(row.fileReference)) {
              expect(typeof value).toBe("string");
            }
          }
        }
      }
      if (record.history.status === "loaded") {
        for (const row of record.history.value) {
          expectNullableString(row.validFrom);
          expectNullableString(row.validTo);
          if ("value" in row) {
            expect(typeof row.value).toBe("string");
          } else {
            expect(typeof row.name).toBe("string");
            expectNullableString(row.role);
          }
        }
      }
    });
  },
  propertyTestTimeout(10_000),
);
