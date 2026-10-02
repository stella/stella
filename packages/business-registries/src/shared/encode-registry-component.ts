/** Encode a URL component without changing the registry's stored source value. */
export const encodeRegistryComponent = (value: string): string =>
  encodeURIComponent(value.toWellFormed());
