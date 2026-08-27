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
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    url.protocol === tlsProtocol ||
    (url.protocol === plaintextProtocol && isLoopbackHostname(url.hostname))
  );
};

/** Origin of the Gotenberg service the generated Compose file publishes. */
export const SELFHOST_GOTENBERG_ORIGIN = "http://gotenberg:3000/";

/**
 * Whether a deployed Gotenberg endpoint stays on a channel its basic-auth
 * credentials and document content may travel: TLS, a loopback sidecar, a
 * provider's encrypted private network, or the Compose service the self-host
 * template generates. `selfhost:doctor` applies the narrower Compose rule to
 * the generated file; this is the runtime rule every deployment answers to.
 */
export const isSecureGotenbergUrl = (value: string) => {
  if (
    isTlsOrLoopbackUrl(value, {
      plaintextProtocol: "http:",
      tlsProtocol: "https:",
    })
  ) {
    return true;
  }
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return (
    url.href === SELFHOST_GOTENBERG_ORIGIN ||
    (url.protocol === "http:" && isRailwayPrivateHostname(url.hostname))
  );
};
