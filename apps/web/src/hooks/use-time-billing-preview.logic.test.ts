import { describe, expect, test } from "bun:test";

import {
  isTimeBillingOffered,
  TIME_BILLING_SOURCE,
  timeBillingSource,
} from "@/hooks/use-time-billing-preview.logic";

const SERVER_ANSWERS = [true, false, undefined] as const;

describe("time billing offer", () => {
  test("a build that ships time billing offers it without asking the server", () => {
    for (const previewRequested of [true, false]) {
      const source = timeBillingSource({
        buildEnabled: true,
        previewRequested,
      });
      expect(source).toBe(TIME_BILLING_SOURCE.build);
      for (const serverEnabled of SERVER_ANSWERS) {
        expect(isTimeBillingOffered(source, serverEnabled)).toBe(true);
      }
    }
  });

  test("a preview offers time billing only once the server reports it on", () => {
    const source = timeBillingSource({
      buildEnabled: false,
      previewRequested: true,
    });
    expect(source).toBe(TIME_BILLING_SOURCE.preview);
    expect(isTimeBillingOffered(source, true)).toBe(true);
    expect(isTimeBillingOffered(source, false)).toBe(false);
    expect(isTimeBillingOffered(source, undefined)).toBe(false);
  });

  test("nothing offers time billing when neither the build nor a preview asks", () => {
    const source = timeBillingSource({
      buildEnabled: false,
      previewRequested: false,
    });
    expect(source).toBe(TIME_BILLING_SOURCE.none);
    for (const serverEnabled of SERVER_ANSWERS) {
      expect(isTimeBillingOffered(source, serverEnabled)).toBe(false);
    }
  });
});
