const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const isLoopbackHostname = (hostname: string) =>
  LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());

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
