import { expect, test } from "bun:test";

import { CLI_LOOPBACK_CLIENT_METADATA } from "@stll/cli/client-metadata-document";

import {
  isReservedStellaClientName,
  mayRegisterClientName,
} from "./cli-client-registration";

test("only the exact public native CLI shape may register the CLI display name", () => {
  const cli = { ...CLI_LOOPBACK_CLIENT_METADATA, client_name: "stella CLI" };
  expect(mayRegisterClientName(cli)).toBe(true);
  for (const override of [
    { application_type: "web" },
    { token_endpoint_auth_method: "client_secret_post" },
    { redirect_uris: ["https://unrelated.example/callback"] },
    {
      redirect_uris: [
        "http://127.0.0.1/callback",
        "https://unrelated.example/callback",
      ],
    },
    { grant_types: ["authorization_code"] },
    { response_types: ["token"] },
  ]) {
    expect(mayRegisterClientName({ ...cli, ...override })).toBe(false);
  }
  expect(mayRegisterClientName({ client_name: "Example connector" })).toBe(
    true,
  );
});

test("case, compatibility characters, whitespace and invisible characters cannot claim first-party names", () => {
  for (const name of [
    "stella",
    "STELLA",
    "stella CLI",
    "stella-cli",
    " Stella  cli ",
    "stеlla",
    "STELLA_CLI",
    "stella\u200bcli",
    "ＳＴＥＬＬＡ ＣＬＩ",
    "𝕤𝕥𝕖𝕝𝕝𝕒",
    "stella\u200b CLI",
    "stella\u00a0CLI",
  ]) {
    expect(isReservedStellaClientName(name)).toBe(true);
    expect(mayRegisterClientName({ client_name: name })).toBe(false);
  }
  expect(isReservedStellaClientName("st3lla")).toBe(false);
});
