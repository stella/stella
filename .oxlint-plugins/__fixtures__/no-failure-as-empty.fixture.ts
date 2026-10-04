// Passive regression fixture for
// `no-failure-as-empty/no-failure-as-empty`.

import { panic } from "better-result";

declare const load: () => Promise<string[]>;
declare const request: (url: string) => Promise<Response>;

export const readItems = async (): Promise<string[]> => {
  try {
    return await load();
    // oxlint-disable-next-line no-failure-as-empty/no-failure-as-empty -- a failed load must not read as an empty list
  } catch {
    return [];
  }
};

export const readDocument = async (
  url: string,
): Promise<string | undefined> => {
  const response = await request(url);
  // oxlint-disable-next-line no-failure-as-empty/no-failure-as-empty -- a 500 must not read as a missing document
  if (!response.ok) {
    return undefined;
  }
  return await response.text();
};

export const readCount = async (url: string): Promise<number> =>
  // oxlint-disable-next-line no-failure-as-empty/no-failure-as-empty -- a failed count must not read as zero
  await request(url)
    .then(async (response) => Number(await response.text()))
    .catch(() => 0);

// expect-clean: no-failure-as-empty/no-failure-as-empty
export const parseOrNull = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const readOrThrow = async (url: string): Promise<string> => {
  const response = await request(url);
  if (response.status === 404) {
    return "";
  }
  if (!response.ok) {
    return panic(`Read failed: ${String(response.status)}`);
  }
  return await response.text();
};
