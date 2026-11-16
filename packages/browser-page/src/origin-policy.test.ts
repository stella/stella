import { describe, expect, test } from "bun:test";

import { createOriginPolicy } from "./origin-policy";

describe("createOriginPolicy", () => {
  const policy = createOriginPolicy({
    hostnames: ["app.example-stella.com"],
    originFromUrl: (rawUrl) =>
      URL.parse(rawUrl)?.origin === "https://api.example-stella.com"
        ? "https://api.example-stella.com"
        : null,
  });

  test("refuses the hosts and origins it is given as stella's", () => {
    expect(
      policy.parseControllableUrl("https://app.example-stella.com/chat"),
    ).toBeNull();
    expect(
      policy.parseControllableUrl("https://api.example-stella.com/v1"),
    ).toBeNull();
    expect(
      policy.parseControllableUrl("https://docs.example-stella.com/")?.hostname,
    ).toBe("docs.example-stella.com");
  });

  test("knows stella's hosts with the DNS root's trailing dot, or in capitals, too", () => {
    for (const rawUrl of [
      "https://app.example-stella.com./chat",
      "https://APP.Example-Stella.com/chat",
      "https://api.example-stella.com./v1",
      "https://API.example-stella.com:443/v1",
    ]) {
      expect(policy.parseControllableUrl(rawUrl)).toBeNull();
    }
    const dotted = createOriginPolicy({
      hostnames: ["app.example-stella.com."],
      originFromUrl: () => null,
    });
    expect(
      dotted.parseControllableUrl("https://app.example-stella.com/"),
    ).toBeNull();
    expect(
      policy.parseControllableUrl("https://research.example.com./doc")
        ?.hostname,
    ).toBe("research.example.com.");
  });

  test("refuses what is not a public HTTPS address", () => {
    for (const rawUrl of [
      "http://research.example.com/",
      "https://user:secret@research.example.com/",
      "https://127.0.0.1/",
      "https://intranet/",
      "not a url",
    ]) {
      expect(policy.parseControllableUrl(rawUrl)).toBeNull();
    }
  });

  test("holds a frame to its origin and the top frame to its address", () => {
    expect(
      policy.isControllableFrame({
        isTopFrame: false,
        origin: "https://research.example.com",
        url: "about:blank",
      }),
    ).toBe(true);
    expect(
      policy.isControllableFrame({
        isTopFrame: true,
        origin: "https://research.example.com",
        url: "about:blank",
      }),
    ).toBe(false);
    expect(
      policy.isControllableFrame({
        isTopFrame: false,
        origin: "null",
        url: "https://research.example.com/",
      }),
    ).toBe(false);
  });
});
