import { CLI_VERSION } from "./generated/cli-version.js";

const LOCAL_CLIENT_IDENTITY_HEADER = "x-stella-local-client";

/** Headers that identify an npm-installed Stella CLI to the API. */
export const localCliClientHeaders = (version: string): Headers =>
  new Headers({
    [LOCAL_CLIENT_IDENTITY_HEADER]: `cli/${version}`,
  });

/** Fetch an API resource with the CLI identity while preserving caller headers. */
export const apiFetch = async (
  input: string | URL,
  init?: RequestInit,
): Promise<Response> => {
  const headers = new Headers(init?.headers);
  for (const [name, value] of localCliClientHeaders(CLI_VERSION)) {
    headers.set(name, value);
  }
  return fetch(input, { ...init, headers });
};
