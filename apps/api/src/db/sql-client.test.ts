import { describe, expect, test } from "bun:test";

import {
  int8ToBigInt,
  int8ToSafeNumber,
  stellaPgCodecs,
} from "@/api/db/sql-client";

describe("int8 codecs", () => {
  test("mode number decodes safe integers and refuses anything else", () => {
    expect(int8ToSafeNumber(42n)).toBe(42);
    expect(int8ToSafeNumber("-7")).toBe(-7);
    expect(int8ToSafeNumber(9_007_199_254_740_991n)).toBe(
      9_007_199_254_740_991,
    );
    for (const value of [
      9_007_199_254_740_993n,
      "9007199254740993",
      "1.5",
      "x",
      null,
    ]) {
      expect(() => int8ToSafeNumber(value), String(value)).toThrow(
        /not a safe integer/u,
      );
    }
  });

  test("mode bigint decodes to BigInt, never a lexical string", () => {
    expect(int8ToBigInt(9_007_199_254_740_993n)).toBe(9_007_199_254_740_993n);
    expect(int8ToBigInt("10")).toBe(10n);
    expect(int8ToBigInt("10") > int8ToBigInt("9")).toBe(true);
    expect(() => int8ToBigInt("1e3")).toThrow(/not an integer/u);
  });

  test("every int8 mode has a decoder", () => {
    expect(stellaPgCodecs.bigint?.normalize).toBe(int8ToBigInt);
    expect(stellaPgCodecs.bigserial?.normalize).toBe(int8ToBigInt);
    expect(stellaPgCodecs["bigint:number"]?.normalize).toBe(int8ToSafeNumber);
    expect(stellaPgCodecs["bigserial:number"]?.normalize).toBe(
      int8ToSafeNumber,
    );
  });
});
