import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import {
  expectNullableString,
  expectRegistryOutcome,
  expectRegistryResponse,
  forEachRegistryMutation,
  mutatedRegistryPayload,
  registryMutation,
  nullableRegistryString,
  registryString,
} from "../shared/property-test-helpers.test.js";
import { lookupByUid } from "./client.js";
import { parseFirm, parseSearchEntry } from "./parse.js";
import type { ZefixCompany, ZefixRawFirm } from "./types.js";
import { validateUid } from "./validation.js";

const firm = fc
  .record(
    {
      uid: fc.oneof(registryString, fc.constant("CHE-191.546.434")),
      uidFormatted: fc.oneof(registryString, fc.constant("CHE-191.546.434")),
      name: registryString,
      legalSeat: registryString,
      legalFormId: fc.double(),
      status: fc.oneof(
        registryString,
        fc.constantFrom("EXISTIEREND", "GELOESCHT"),
      ),
      deleteDate: nullableRegistryString,
      cantonalExcerptWeb: registryString,
    },
    { requiredKeys: ["name"] },
  )
  .map((raw) => raw satisfies ZefixRawFirm);

test("firm projections retain valid identities and typed optional fields", () => {
  fc.assert(
    fc.property(firm, (raw) => {
      const company = expectRegistryOutcome(() => parseFirm(raw));
      if (company === undefined) {
        return;
      }
      expect(parseSearchEntry(raw)).toEqual(
        company === null
          ? null
          : {
              uid: company.uid,
              uidFormatted: company.uidFormatted,
              name: company.name,
              legalSeat: company.legalSeat,
              status: company.status,
              registryUrl: company.registryUrl,
            },
      );
      if (company === null) {
        return;
      }
      expect(validateUid(company.uid)).toBe(true);
      expect(company.name).toBe(raw.name.trim());
      expect(company.name.length).toBeGreaterThan(0);
      expectNullableString(company.legalSeat);
      expectNullableString(company.registryUrl);
      expect(
        company.legalFormId === null || Number.isFinite(company.legalFormId),
      ).toBe(true);
      expect(["active", "deleted", "unknown"]).toContain(company.status.type);
      if (company.status.type === "deleted") {
        expectNullableString(company.status.deletedAt);
      }
      if (company.status.type === "unknown") {
        expectNullableString(company.status.upstreamValue);
      }
    }),
    propertyConfig({ seed: propertySeed() }),
  );
});

const expectTypedOutput = (output: ZefixCompany) => {
  expect(typeof output.name).toBe("string");
  expect(validateUid(output.uid)).toBe(true);
  expectNullableString(output.legalSeat);
  expectNullableString(output.registryUrl);
  expect(
    output.legalFormId === null || Number.isFinite(output.legalFormId),
  ).toBe(true);
  expect(["active", "deleted", "unknown"]).toContain(output.status.type);
  if (output.status.type === "deleted") {
    expectNullableString(output.status.deletedAt);
  }
  if (output.status.type === "unknown") {
    expectNullableString(output.status.upstreamValue);
  }
};

test("firm response mutations retain typed projections or registry failures", async () => {
  await fc.assert(
    fc.asyncProperty(
      firm,
      fc.nat(),
      registryMutation,
      async (raw, selected, mutation) => {
        const original = {
          list: [
            {
              ...raw,
              uid: "CHE191546434",
              uidFormatted: "CHE-191.546.434",
              name: "Swiss Re AG",
            },
          ],
        };
        const operation = async () =>
          lookupByUid("191546434", { observer: "unobserved" });
        expect(await expectRegistryResponse(original, operation)).toMatchObject(
          { uid: "191546434", name: "Swiss Re AG" },
        );
        const payload = mutatedRegistryPayload({
          payload: original,
          selected,
          mutation,
        });
        const output = await expectRegistryResponse(payload, operation);
        if (!output) {
          return;
        }
        expectTypedOutput(output);
      },
    ),
    propertyConfig({ seed: propertySeed(), numRuns: 20 }),
  );
});

test("every consumed response field supports missing, null and wrong-type mutations", async () => {
  const original = {
    list: [
      {
        name: "Swiss Re AG",
        uid: "CHE191546434",
        uidFormatted: "CHE-191.546.434",
        legalSeat: "Zürich",
        legalFormId: 3,
        status: "GELOESCHT",
        deleteDate: "2026-01-01",
        cantonalExcerptWeb: "https://example.test/firm",
      } satisfies ZefixRawFirm,
    ],
  };
  const operation = async () =>
    lookupByUid("191546434", { observer: "unobserved" });
  expect(await expectRegistryResponse(original, operation)).toMatchObject({
    uid: "191546434",
    name: "Swiss Re AG",
  });
  await forEachRegistryMutation(original, async (payload) => {
    const output = await expectRegistryResponse(payload, operation);
    if (output) {
      expectTypedOutput(output);
    }
  });
});
