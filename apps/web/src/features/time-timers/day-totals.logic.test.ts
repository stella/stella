import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { dailyTargetFormSchema } from "./day-totals.logic";

const schema = dailyTargetFormSchema("Invalid daily target");

describe("daily target input", () => {
  test("accepts every whole-minute target within the day", () => {
    for (let minutes = 1; minutes <= 1440; minutes += 1) {
      const result = v.safeParse(schema, { minutes: ` ${minutes} ` });
      expect(result.success).toBe(true);
      expect(result.output).toEqual({ minutes });
    }
  });

  test("clears the target only with blank input", () => {
    for (const minutes of ["", " ", "\t\n"]) {
      expect(v.safeParse(schema, { minutes }).output).toEqual({
        minutes: null,
      });
    }
  });

  test("refuses out-of-range, fractional and nonnumeric targets", () => {
    for (const minutes of [
      "0",
      "1441",
      "-1",
      "1.5",
      "1e2",
      "0x10",
      "NaN",
      "Infinity",
      "12minutes",
      "99999999999999999999999999",
    ]) {
      const result = v.safeParse(schema, { minutes });
      expect(result.success).toBe(false);
      expect(result.issues?.at(0)?.message).toBe("Invalid daily target");
    }
  });
});
