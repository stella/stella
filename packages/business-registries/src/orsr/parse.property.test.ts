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
  expectNullableString,
} from "../shared/property-test-helpers.test.js";
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
            for (const bodyMember of body.members)
              {expect(bodyMember.name.length).toBeGreaterThan(0);}
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
