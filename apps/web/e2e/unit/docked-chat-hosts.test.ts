import { expect, test } from "bun:test";

import { readDockedChatHosts } from "../helpers/docked-chat-hosts";

test("docked chat census includes reader and inspector hosts but excludes non-page endpoints", () => {
  const { hosts, providerSources } = readDockedChatHosts();
  expect(providerSources.length).toBeGreaterThan(0);
  expect(new Set(hosts.map(({ template }) => template)).size).toBe(
    hosts.length,
  );
  expect(hosts.some(({ surfaces }) => surfaces.includes("reader"))).toBe(true);
  expect(hosts.some(({ surfaces }) => surfaces.includes("template"))).toBe(
    true,
  );
  expect(
    hosts.some(
      ({ template, surfaces }) =>
        template === "/chat" && surfaces.includes("inspector"),
    ),
  ).toBe(true);
  for (const template of [
    "/law/cases/research",
    "/law/cases/research/$tableId",
  ]) {
    expect(
      hosts.find((host) => host.template === template)?.surfaces,
    ).toContain("inspector");
  }
  expect(
    hosts.some(
      ({ template }) =>
        template.startsWith("/auth") ||
        template.includes("sitemap") ||
        template.endsWith("/download"),
    ),
  ).toBe(false);
});
