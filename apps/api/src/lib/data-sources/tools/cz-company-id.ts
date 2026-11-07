import { Result } from "better-result";

import type { RecordValue } from "@stll/api-contract/record-schema";

import type { DataSourceInputCheck } from "@/api/lib/data-sources/contract";

const ICO_LENGTH = 8;
const ICO_WEIGHTS = [8, 7, 6, 5, 4, 3, 2] as const;

/**
 * The IČO check digit (mod 11 over the first seven digits). Kept here rather
 * than imported from the register package so this module acquires no register
 * client capability; the register lookup itself goes through its owner.
 */
const hasValidIcoChecksum = (ico: string): boolean => {
  // The caller has already matched eight ASCII digits, so index access is exact.
  const digits = Array.from({ length: ICO_LENGTH }, (_, index) =>
    "0123456789".indexOf(ico.charAt(index)),
  );
  const sum = ICO_WEIGHTS.reduce(
    (total, weight, index) => total + weight * (digits[index] ?? 0),
    0,
  );
  return digits[7] === (11 - (sum % 11)) % 10;
};

/**
 * A Czech company ID (IČO) as the register keys it: spaces removed, padded to
 * eight digits (older IČOs are written without their leading zeros), and its
 * checksum valid. A value that fails is refused, never corrected further.
 */
export const checkCzCompanyIdInput = (
  input: RecordValue,
  key: string,
): DataSourceInputCheck => {
  const raw = input[key];
  const compact = typeof raw === "string" ? raw.replaceAll(/\s/gu, "") : "";
  const padded = /^\d{1,8}$/u.test(compact)
    ? compact.padStart(ICO_LENGTH, "0")
    : compact;
  if (!/^\d{8}$/u.test(padded) || !hasValidIcoChecksum(padded)) {
    return Result.err([
      {
        key,
        code: "invalid",
        message: "Not a valid Czech company ID (IČO): wrong length or checksum",
      },
    ]);
  }
  return Result.ok({ ...input, [key]: padded });
};
