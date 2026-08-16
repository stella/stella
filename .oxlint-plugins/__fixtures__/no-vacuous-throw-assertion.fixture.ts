// Passive regression fixture for
// `no-vacuous-throw-assertion/no-vacuous-throw-assertion`.

import { expect } from "bun:test";

const corpusIndexId = (prefix: string, region: string): string => {
  if (!/^[a-z][a-z0-9_]*$/u.test(prefix)) {
    throw new TypeError(`corpus index prefix is not an identifier: ${prefix}`);
  }
  if (!/^[a-z]{3}$/u.test(region)) {
    throw new TypeError(`corpus index region is not alpha-3: ${region}`);
  }
  return `${prefix}_${region}`;
};

const loadCorpus = async (indexId: string): Promise<string> => {
  if (indexId === "") {
    throw new RangeError("corpus index id is empty");
  }
  return await Promise.resolve(indexId);
};

export const vacuousAssertions = (): void => {
  // MUST flag: any thrown value satisfies this, including an unrelated
  // TypeError from a renamed argument.
  // oxlint-disable-next-line no-vacuous-throw-assertion/no-vacuous-throw-assertion -- fixture: an unargumented toThrow pins no error
  expect(() => corpusIndexId("1_case_law", "svk")).toThrow();

  // MUST flag: the legacy alias is the same matcher.
  // oxlint-disable-next-line no-vacuous-throw-assertion/no-vacuous-throw-assertion -- fixture: toThrowError is the same unargumented assertion
  expect(() => corpusIndexId("", "svk")).toThrowError();
};

// bun-types declares `.rejects.toThrow` as void, so awaiting it trips
// type-aware lint; the assertion shape is what this fixture pins.
export const vacuousRejection = (): void => {
  // MUST flag: the `.rejects` chain is the same assertion over a promise.
  // oxlint-disable-next-line no-vacuous-throw-assertion/no-vacuous-throw-assertion -- fixture: an unargumented rejects.toThrow pins no error
  expect(loadCorpus("")).rejects.toThrow();
};

export const namedAssertions = (): void => {
  // Allowed: a message substring discriminates between errors.
  expect(() => corpusIndexId("1_case_law", "svk")).toThrow(
    "corpus index prefix is not an identifier",
  );

  // Allowed: a regex pins the shape of the message.
  expect(() => corpusIndexId("case_law_v1", "sk-1")).toThrow(
    /region is not alpha-3/u,
  );

  // Allowed: an error class pins the constructor.
  expect(loadCorpus("")).rejects.toThrow(RangeError);

  // Allowed: `.not.toThrow()` asserts the absence of every error, so there is
  // no error to name.
  expect(() => corpusIndexId("case_law_v1", "svk")).not.toThrow();
};

// Allowed: an unrelated method that happens to share the name is not an
// `expect(...)` assertion.
const retryPolicy = { toThrow: (): string => "escalate" };
export const unrelatedToThrow = retryPolicy.toThrow();
