import { CLI_VERSION } from "./generated/cli-version.js";

export const LOCAL_CLIENT_IDENTITY_HEADER = "x-stella-local-client";
export const CLI_LOCAL_CLIENT_IDENTITY: string = `cli/${CLI_VERSION}`;

/** Fetch an API resource with the CLI identity while preserving caller headers. */
export const apiFetch = async (
  input: string | URL,
  init?: RequestInit,
): Promise<Response> => {
  const headers = new Headers(init?.headers);
  headers.set(LOCAL_CLIENT_IDENTITY_HEADER, CLI_LOCAL_CLIENT_IDENTITY);
  return fetch(input, { ...init, headers });
};
