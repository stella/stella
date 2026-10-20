export const LOCAL_CLIENT_IDENTITY_HEADER = "x-stella-local-client";

export const LOCAL_CLIENT_KINDS = ["cli", "mcp-kit", "desktop"] as const;
export type LocalClientKind = (typeof LOCAL_CLIENT_KINDS)[number];

/** The single wire representation used by locally installed API clients. */
export const localClientIdentity = (
  kind: LocalClientKind,
  version: string,
): string => `${kind}/${version}`;
