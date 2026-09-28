import { describe, expect, test } from "bun:test";

import { normalizeEli } from "./eli";
import type { Normalized } from "./normalized";

const HOSTS = { cz: "https://www.e-sbirka.cz" } as const;
const WORK = "https://www.e-sbirka.cz/eli/cz/sb/2012/89";

/** A stand-in for the caller's gazette-citation reader. */
const readCitation = (text: string): string | undefined =>
  text === "89/2012 Sb." ? "/eli/cz/sb/2012/89" : undefined;

const outcome = (result: Normalized<string>): string =>
  result.ok ? result.value : `ask: ${result.hint}`;

const read = (input: unknown): Normalized<string> =>
  normalizeEli(input, { hosts: HOSTS, readCitation });

describe("legislation identifiers", () => {
  test("a canonical ELI is taken as it is", () => {
    expect(read(WORK)).toEqual({ ok: true, value: WORK });
  });

  test.each([
    ["/eli/cz/sb/2012/89"],
    ["eli/cz/sb/2012/89"],
    ["cz/sb/2012/89"],
    ["e-sbirka.cz/eli/cz/sb/2012/89"],
    ["https://e-sbirka.cz/eli/cz/sb/2012/89/"],
    ["http://www.e-sbirka.cz/eli/cz/sb/2012/89"],
    ["/eli/CZ/SB/2012/89"],
    ["  /eli/cz/sb/2012/89  "],
    ["/eli/cz/sb/89/2012"],
    ["89/2012 Sb."],
  ])("reads %s as the work ELI, with a note", (input) => {
    expect(read(input)).toEqual({
      ok: true,
      value: WORK,
      note: `Read ${JSON.stringify(input)} as "${WORK}".`,
    });
  });

  test("a jurisdiction with no known host keeps the origin it came with", () => {
    expect(
      outcome(read("https://www.legislation.gov.uk/eli/UK/UKPGA/2010/15/")),
    ).toBe("https://www.legislation.gov.uk/eli/uk/ukpga/2010/15");
    expect(outcome(read("/eli/sk/zz/2012/89"))).toBe(
      'ask: No publisher is known for the jurisdiction "sk". Pass the eli a search result returned.',
    );
  });

  test("a path past the work asks for the work, and names as_of for a date", () => {
    expect(outcome(read("/eli/cz/sb/2012/89/2024-01-01"))).toBe(
      `ask: Pass the work ELI "${WORK}" as eli; a date goes in as_of.`,
    );
    expect(outcome(read("/eli/cz/sb/2012/89/par_5"))).toBe(
      `ask: Pass the work ELI "${WORK}" as eli.`,
    );
  });

  test("two years in the year and number slots ask with both readings", () => {
    expect(outcome(read("/eli/cz/sb/2012/2000"))).toBe(
      "ask: Both 2012 and 2000 read as a year, so this names " +
        '"https://www.e-sbirka.cz/eli/cz/sb/2012/2000" or ' +
        '"https://www.e-sbirka.cz/eli/cz/sb/2000/2012". Pass the one you mean.',
    );
    // The publisher's own spelling is its own order.
    const canonical = "https://www.e-sbirka.cz/eli/cz/sb/2012/2000";
    expect(read(canonical)).toEqual({ ok: true, value: canonical });
  });

  test("something that is not an ELI asks, in the caller's words when given", () => {
    expect(outcome(read("zákon o obchodních korporacích"))).toBe(
      "ask: Pass the eli a search result returned.",
    );
    expect(outcome(read("https://www.e-sbirka.cz/sb/2012/89"))).toBe(
      "ask: Pass the eli a search result returned.",
    );
    expect(
      outcome(
        normalizeEli(42, {
          hosts: HOSTS,
          hint: "Pass eli from search_legislation.",
        }),
      ),
    ).toBe("ask: Pass eli from search_legislation.");
  });

  test("a configured host's trailing slashes are cut", () => {
    expect(
      outcome(
        normalizeEli("/eli/cz/sb/2012/89", {
          hosts: { cz: "https://www.e-sbirka.cz///" },
        }),
      ),
    ).toBe(WORK);
  });

  test("a work whose segments carry no year keeps the publisher's order", () => {
    // Nothing says the order is wrong, so only the spelling is canonical;
    // whether the work exists is the corpus's answer, not this reader's.
    const result = read("/eli/cz/sb/12/89");
    expect(result.ok && result.value).toBe(
      "https://www.e-sbirka.cz/eli/cz/sb/12/89",
    );
    expect(read("https://www.e-sbirka.cz/eli/cz/sb/9999/1")).toEqual({
      ok: true,
      value: "https://www.e-sbirka.cz/eli/cz/sb/9999/1",
    });
  });
});
