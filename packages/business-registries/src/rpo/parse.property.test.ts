import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { RegistryError } from "../shared/errors.js";
import {
  expectRegistryResponses,
  registryString,
  registryExtras,
  forEachRegistryMutation,
  expectRegistryOutcome,
  expectNullableString,
} from "../shared/property-test-helpers.test.js";
import { lookupByIco, searchByName } from "./client.js";
import {
  parseAddress,
  parseEntity,
  parseSearchHit,
  entityUrl,
} from "./parse.js";
import type { RpoRawAddress, RpoRawEntity } from "./types.js";

const code = fc.record(
  { code: registryString, value: registryString },
  { requiredKeys: [] },
);
const timed = fc.record(
  { value: registryString, validFrom: registryString, validTo: registryString },
  { requiredKeys: [] },
);
const address = fc
  .record(
    {
      street: registryString,
      buildingNumber: registryString,
      regNumber: fc.integer(),
      postalCodes: fc.array(registryString, { maxLength: 3 }),
      municipality: code,
      country: code,
      formatedAddress: registryString,
      validFrom: registryString,
      validTo: registryString,
    },
    { requiredKeys: [] },
  )
  .map((raw) => raw satisfies RpoRawAddress);
const person = fc.record(
  {
    fullName: registryString,
    identifier: registryString,
    address,
    stakeholderType: code,
    statutoryBodyMember: code,
    validFrom: registryString,
    validTo: registryString,
    personName: fc.record(
      {
        formatedName: registryString,
        givenNames: fc.array(registryString, { maxLength: 3 }),
        familyNames: fc.array(registryString, { maxLength: 3 }),
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);
const entity = fc
  .record(
    {
      id: fc.integer(),
      identifiers: fc.array(timed, { maxLength: 5 }),
      fullNames: fc.array(timed, { maxLength: 5 }),
      addresses: fc.array(address, { maxLength: 4 }),
      termination: registryString,
      establishment: registryString,
      stakeholders: fc.array(person, { maxLength: 4 }),
      statutoryBodies: fc.array(person, { maxLength: 4 }),
      authorizations: fc.array(timed, { maxLength: 4 }),
      sourceRegister: fc.record(
        {
          value: code,
          registrationOffices: fc.array(timed, { maxLength: 4 }),
          registrationNumbers: fc.array(timed, { maxLength: 4 }),
        },
        { requiredKeys: [] },
      ),
    },
    { requiredKeys: ["id"] },
  )
  .map((raw) => raw satisfies RpoRawEntity);

test(
  "entity and search agree on selected identity and normalized names",
  () => {
    fc.assert(
      fc.property(entity, registryExtras, (raw, extras) => {
        const enriched = { extraFields: extras, ...raw };
        const parsed = expectRegistryOutcome(() => parseEntity(enriched));
        const search = expectRegistryOutcome(() => parseSearchHit(enriched));
        if (parsed === undefined || search === undefined) {
          return;
        }
        expect(parsed === null).toBe(search === null);
        if (!parsed || !search) {
          return;
        }
        expect(search.ico).toBe(parsed.ico);
        expect(search.name).toBe(parsed.name);
        expect(search.rpoId).toBe(raw.id);
        expect(search.status).toEqual(parsed.status);
        expect(search.address).toBe(parsed.address?.textAddress ?? null);
        expect(parsed.registryUrl).toBe(entityUrl(raw.id));
        expect(
          raw.identifiers?.some((row) => row.value?.trim() === parsed.ico),
        ).toBe(true);
        expect(
          raw.fullNames?.some(
            (row) => row.value?.replaceAll(/\s+/gu, " ").trim() === parsed.name,
          ),
        ).toBe(true);
        for (const parsedPerson of [
          ...parsed.stakeholders,
          ...parsed.statutoryBodies,
        ]) {
          expect(parsedPerson.name.length).toBeGreaterThan(0);
          expect(parsedPerson.name).toBe(parsedPerson.name.trim());
          expectNullableString(parsedPerson.identifier);
        }
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "address normalization preserves foreign postal spelling and country labels",
  () => {
    fc.assert(
      fc.property(address, registryExtras, (raw, extras) => {
        const enriched = { extraFields: extras, ...raw };
        const parsed = expectRegistryOutcome(() => parseAddress(enriched));
        if (!parsed) {
          return;
        }
        expect(parsed.country).toBe(
          raw.country?.value?.replaceAll(/\s+/gu, " ").trim() || null,
        );
        const postal = raw.postalCodes?.at(0);
        if (raw.country?.code !== undefined && raw.country.code !== "703") {
          expect(parsed.postalCode).toBe(postal?.trim() || null);
        }
        for (const value of Object.values(parsed)) {
          expectNullableString(value);
        }
      }),
      propertyConfig({ seed: propertySeed(), numRuns: 80 }),
    );
  },
  propertyTestTimeout(10_000),
);

test.each(["search", "entity"] as const)(
  "%s response mutations yield typed results with valid domain atoms",
  async (kind) => {
    const searchPayload: unknown = await Bun.file(
      new URL("__fixtures__/search-by-ico-eset.json", import.meta.url),
    ).json();
    const entityPayload: unknown = await Bun.file(
      new URL("__fixtures__/entity-eset.json", import.meta.url),
    ).json();
    const payload = kind === "search" ? searchPayload : entityPayload;
    const baseline = await expectRegistryResponses(
      (url) =>
        new URL(url).pathname.includes("/entity/")
          ? entityPayload
          : searchPayload,
      async () =>
        kind === "search"
          ? await searchByName("ESET")
          : await lookupByIco("31333532", { view: "historical" }),
    );
    expect(baseline?.isOk()).toBe(true);
    if (baseline?.isOk()) {
      expect(baseline.value).not.toBeNull();
      if (Array.isArray(baseline.value)) {
        expect(baseline.value.length).toBeGreaterThan(0);
      }
    }
    await forEachRegistryMutation(payload, async (mutated) => {
      const result = await expectRegistryResponses(
        (url) => {
          if (new URL(url).pathname.includes("/entity/")) {
            return kind === "entity" ? mutated : entityPayload;
          }
          return kind === "search" ? mutated : searchPayload;
        },
        async () =>
          kind === "search"
            ? await searchByName("ESET")
            : await lookupByIco("31333532", { view: "historical" }),
      );
      if (result === undefined) {
        return;
      }
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(RegistryError);
        return;
      }
      const value = result.value;
      if (!value) {
        return;
      }
      if (Array.isArray(value)) {
        for (const row of value) {
          expect(typeof row.ico).toBe("string");
          expect(typeof row.name).toBe("string");
          expectNullableString(row.address);
        }
        return;
      }
      expect(value.ico).toBe("31333532");
      expect(typeof value.name).toBe("string");
      expectNullableString(value.establishedAt);
      expectNullableString(value.terminatedAt);
      if (value.address) {
        for (const atom of Object.values(value.address)) {
          expectNullableString(atom);
        }
      }
      if (value.sourceRegister) {
        expect(typeof value.sourceRegister.name).toBe("string");
        for (const atom of [
          value.sourceRegister.code,
          value.sourceRegister.registrationOffice,
          value.sourceRegister.registrationNumber,
        ]) {
          expectNullableString(atom);
        }
      }
      for (const status of value.legalStatuses) {
        expect(typeof status).toBe("string");
      }
      for (const parsedPerson of [
        ...value.stakeholders,
        ...value.statutoryBodies,
      ]) {
        expect(typeof parsedPerson.name).toBe("string");
        for (const atom of [
          parsedPerson.organName,
          parsedPerson.position,
          parsedPerson.identifier,
          parsedPerson.address,
        ]) {
          expectNullableString(atom);
        }
      }
      for (const relative of [...value.predecessors, ...value.successors]) {
        expect(typeof relative.name).toBe("string");
        expectNullableString(relative.ico);
        expectNullableString(relative.validFrom);
      }
      for (const row of [
        ...value.formerNames,
        ...value.authorizations,
        ...value.activities,
      ]) {
        expect(typeof row.value).toBe("string");
      }
      for (const row of value.formerAddresses) {
        expectNullableString(row.validFrom);
        expectNullableString(row.validTo);
        for (const atom of Object.values(row.value)) {
          expectNullableString(atom);
        }
      }
      if (value.legalForm) {
        expectNullableString(value.legalForm.code);
      }
      if (value.mainActivity) {
        expectNullableString(value.mainActivity.code);
      }
      for (const money of [value.shareCapital, value.shareCapitalPaid]) {
        if (money) {
          expect(typeof money.amount).toBe("number");
          expectNullableString(money.currency);
        }
      }
      for (const row of [
        ...value.formerNames,
        ...value.authorizations,
        ...value.activities,
        ...value.stakeholders,
        ...value.statutoryBodies,
      ]) {
        expectNullableString(row.validFrom);
        expectNullableString(row.validTo);
      }
    });
  },
  propertyTestTimeout(10_000),
);
