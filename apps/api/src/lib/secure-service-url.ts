const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Railway encrypts *.railway.internal traffic inside one project environment.
const RAILWAY_PRIVATE_HOST_SUFFIX = ".railway.internal";

export const isLoopbackHostname = (hostname: string) =>
  LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());

export const isRailwayPrivateHostname = (hostname: string) => {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname.length > RAILWAY_PRIVATE_HOST_SUFFIX.length &&
    normalizedHostname.endsWith(RAILWAY_PRIVATE_HOST_SUFFIX)
  );
};

type TlsOrLoopbackUrlOptions = {
  plaintextProtocol: string;
  tlsProtocol: string;
};

export const isTlsOrLoopbackUrl = (
  value: string,
  { plaintextProtocol, tlsProtocol }: TlsOrLoopbackUrlOptions,
) => {
  const url = new URL(value);
  return (
    url.protocol === tlsProtocol ||
    (url.protocol === plaintextProtocol && isLoopbackHostname(url.hostname))
  );
};
