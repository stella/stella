import * as v from "valibot";

const apiUrlSchema = v.pipe(
  v.string("EXPO_PUBLIC_API_URL is required."),
  v.url("EXPO_PUBLIC_API_URL must be a valid URL."),
  v.transform((value) => new URL(value)),
  v.check(
    (value) => value.protocol === "http:" || value.protocol === "https:",
    "EXPO_PUBLIC_API_URL must use HTTP or HTTPS.",
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
