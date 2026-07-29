import * as v from "valibot";

const LOOPBACK_API_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const usesSecureTransport = (value: URL): boolean =>
  value.protocol === "https:" ||
  (value.protocol === "http:" && LOOPBACK_API_HOSTS.has(value.hostname));

const apiUrlSchema = v.pipe(
  v.string("EXPO_PUBLIC_API_URL is required."),
  v.url("EXPO_PUBLIC_API_URL must be a valid URL."),
  v.transform((value) => new URL(value)),
  v.check(
    usesSecureTransport,
    "EXPO_PUBLIC_API_URL must use HTTPS (HTTP is allowed only for a loopback development server).",
  ),
  v.check(
    (value) =>
      value.username === "" &&
      value.password === "" &&
      value.search === "" &&
      value.hash === "",
    "EXPO_PUBLIC_API_URL cannot contain credentials, query parameters, or a fragment.",
  ),
  v.transform((value) => value.href),
);

export const parseMobileApiUrl = (value: unknown) =>
  v.parse(apiUrlSchema, value);
