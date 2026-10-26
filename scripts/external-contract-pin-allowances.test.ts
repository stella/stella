import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { removeWaiver } from "./dated-waiver-probes";
import { collectWaivers, expiredWaiverFailures } from "./dated-waivers";
import {
  EXTERNAL_CONTRACT_PIN_ALLOWANCES_PATH,
  type ExternalContractPinAllowance,
  readExternalContractPinAllowances,
} from "./external-contract-pin-allowances";

const allowance = {
  id: "fixture-sdk-pin",
  system: "fixture-system",
  pins: { "fixture-sdk": "1.2.3" },
  checkedAt: "2026-10-14T12:00:00.000Z",
  expiresAt: "2026-10-21T12:00:00.000Z",
  reason: "Replay evidence requires an offline SDK fixture update.",
};
const text = (entries: ExternalContractPinAllowance[] = [allowance]) =>
  JSON.stringify({ allowances: entries });

test("external contract pin allowances accept only positive intervals up to seven UTC days", () => {
  assertProperty(
    "external contract pin allowances accept only positive intervals up to seven UTC days",
    fc.property(
      fc.integer({ min: -1, max: 7 * 86_400_000 + 1 }),
      (interval) => {
        const entry = {
          ...allowance,
          expiresAt: new Date(
            Date.parse(allowance.checkedAt) + interval,
          ).toISOString(),
        };
        if (interval <= 0 || interval > 7 * 86_400_000) {
          expect(() =>
            readExternalContractPinAllowances(text([entry])),
          ).toThrow("must expire within seven days");
          return;
        }
        expect(readExternalContractPinAllowances(text([entry]))).toEqual([
          entry,
        ]);
      },
    ),
  );
  for (const interval of [0, 7 * 86_400_000 + 1]) {
    expect(() =>
      readExternalContractPinAllowances(
        text([
          {
            ...allowance,
            expiresAt: new Date(
              Date.parse(allowance.checkedAt) + interval,
            ).toISOString(),
          },
        ]),
      ),
    ).toThrow("must expire within seven days");
  }
});

test("pin allowances reject noncanonical dates, empty pins and duplicate identities", () => {
  for (const checkedAt of [
    "2026-10-14",
    "2026-10-14T12:00:00Z",
    "2026-02-30T00:00:00.000Z",
    "invalid",
  ]) {
    expect(() =>
      readExternalContractPinAllowances(text([{ ...allowance, checkedAt }])),
    ).toThrow("requires a canonical UTC timestamp");
  }
  expect(() =>
    readExternalContractPinAllowances(text([{ ...allowance, pins: {} }])),
  ).toThrow("has no pins");
  for (const duplicate of [allowance, { ...allowance, id: "another-id" }]) {
    expect(() =>
      readExternalContractPinAllowances(text([allowance, duplicate])),
    ).toThrow("Duplicate external contract pin allowance");
  }
});

test("registered pin allowances fail exactly at expiry and heal with a single offline check", () => {
  const source = text();
  const read = (file: string) =>
    file === EXTERNAL_CONTRACT_PIN_ALLOWANCES_PATH
      ? source
      : JSON.stringify({ waivers: [] });
  const entries = collectWaivers({
    read,
    docs: [],
    audit: [],
    bunfigs: [],
    releaseAgeSources: {},
    externalContractPinAllowances: readExternalContractPinAllowances(source),
  });
  expect(
    expiredWaiverFailures(entries, new Date("2026-10-21T11:59:59.999Z")),
  ).toEqual([]);
  expect(expiredWaiverFailures(entries, new Date(allowance.expiresAt))).toEqual(
    [
      `${EXTERNAL_CONTRACT_PIN_ALLOWANCES_PATH}:1 dated waiver expired: ${allowance.id}`,
    ],
  );
  const entry = entries.at(0);
  if (!entry) {
    throw new TypeError("Missing pin allowance inventory fixture");
  }
  expect(entry.probe).toEqual({
    command: ["bun", "scripts/check-external-contracts.ts", "--check"],
    attempts: 1,
  });
  const changes = removeWaiver(entry, read);
  expect(
    changes.map(({ after }) => readExternalContractPinAllowances(after)),
  ).toEqual([[]]);
  expect(() =>
    removeWaiver({ ...entry, expiresAt: allowance.checkedAt }, read),
  ).toThrow("anchor missing");
});
