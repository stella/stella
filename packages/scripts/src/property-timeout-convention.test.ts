import { describe, expect, test } from "bun:test";
import path from "node:path";

import { collectPropertyTimeoutViolations } from "./property-timeout-convention";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const PROPERTY_MARKER = ["fc", "assert"].join(".");
const TEST_FILE_GLOB = "{apps,packages}/**/*.test.{ts,tsx}";

const collectRepositoryViolations = async (): Promise<string[]> => {
  const violations: string[] = [];
  for await (const relativePath of new Bun.Glob(TEST_FILE_GLOB).scan({
    cwd: REPO_ROOT,
  })) {
    const source = await Bun.file(path.resolve(REPO_ROOT, relativePath)).text();
    if (source.includes(PROPERTY_MARKER)) {
      violations.push(
        ...collectPropertyTimeoutViolations({ relativePath, source }),
      );
    }
  }
  return violations;
};

describe("property-test timeout convention", () => {
  test("every explicit Bun timeout override follows the property scale factor", async () => {
    expect(await collectRepositoryViolations()).toEqual([]);
  });

  test("detects aliases, positional values, and options", () => {
    const violations = collectPropertyTimeoutViolations({
      relativePath: "fixture.property.test.ts",
      source: `
        import { beforeAll as setup, setDefaultTimeout, test } from "bun:test";
        setDefaultTimeout(5_000);
        test("positional", () => {}, 20_000);
        test("options", () => {}, { timeout: 20_000 });
        setup(() => {}, { timeout: 20_000 });
      `,
    });

    expect(violations).toHaveLength(4);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("setDefaultTimeout timeout"),
        expect.stringContaining("test timeout"),
        expect.stringContaining("beforeAll timeout"),
      ]),
    );
  });

  test("accepts factor-scaled overrides", () => {
    expect(
      collectPropertyTimeoutViolations({
        relativePath: "fixture.property.test.ts",
        source: `
          import { beforeAll, setDefaultTimeout, test } from "bun:test";
          setDefaultTimeout(propertyTestTimeout(5_000));
          test("positional", () => {}, propertyTestTimeout(20_000));
          beforeAll(() => {}, { timeout: propertyTestTimeout(20_000) });
        `,
      }),
    ).toEqual([]);
  });

  test("detects timeout options hidden behind spreads", () => {
    const violations = collectPropertyTimeoutViolations({
      relativePath: "fixture.property.test.ts",
      source: `
        import { beforeAll, test } from "bun:test";
        const opaqueOptions = { timeout: propertyTestTimeout(20_000) };
        test("inline spread", () => {}, { ...{ timeout: 20_000 } });
        beforeAll(() => {}, { ...opaqueOptions });
      `,
    });

    expect(violations).toHaveLength(2);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("test timeout"),
        expect.stringContaining("beforeAll timeout"),
      ]),
    );
  });

  test("accepts factor-scaled inline spread options", () => {
    expect(
      collectPropertyTimeoutViolations({
        relativePath: "fixture.property.test.ts",
        source: `
          import { test } from "bun:test";
          test("inline spread", () => {}, {
            ...{ timeout: propertyTestTimeout(20_000) },
          });
        `,
      }),
    ).toEqual([]);
  });

  test("detects jest timeout overrides across import forms", () => {
    const violations = collectPropertyTimeoutViolations({
      relativePath: "fixture.property.test.ts",
      source: `
        import { jest, jest as bunJest } from "bun:test";
        import * as bt from "bun:test";
        jest.setTimeout(20_000);
        bunJest["setTimeout"](20_000);
        bt.jest.setTimeout(20_000);
        bt["jest"]["setTimeout"](20_000);
      `,
    });

    expect(violations).toHaveLength(4);
    expect(violations).toEqual(
      violations.map(() => expect.stringContaining("jest.setTimeout timeout")),
    );
  });

  test("accepts factor-scaled jest timeout overrides", () => {
    expect(
      collectPropertyTimeoutViolations({
        relativePath: "fixture.property.test.ts",
        source: `
          import { jest as bunJest } from "bun:test";
          import * as bt from "bun:test";
          bunJest.setTimeout(propertyTestTimeout(20_000));
          bt.jest.setTimeout(propertyTestTimeout(20_000));
        `,
      }),
    ).toEqual([]);
  });

  test("detects namespace-import timeout overrides", () => {
    const violations = collectPropertyTimeoutViolations({
      relativePath: "fixture.property.test.ts",
      source: `
        import * as bt from "bun:test";
        bt.test("positional", () => {}, 20_000);
        bt["beforeAll"](() => {}, { timeout: 20_000 });
        bt.test.each([[1]])("table", () => {}, 20_000);
      `,
    });

    expect(violations).toHaveLength(3);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("test timeout"),
        expect.stringContaining("beforeAll timeout"),
      ]),
    );
  });

  test("accepts factor-scaled namespace-import overrides", () => {
    expect(
      collectPropertyTimeoutViolations({
        relativePath: "fixture.property.test.ts",
        source: `
          import * as bt from "bun:test";
          bt.setDefaultTimeout(propertyTestTimeout(5_000));
          bt.test("positional", () => {}, propertyTestTimeout(20_000));
          bt.beforeAll(() => {}, {
            timeout: propertyTestTimeout(20_000),
          });
        `,
      }),
    ).toEqual([]);
  });
});
