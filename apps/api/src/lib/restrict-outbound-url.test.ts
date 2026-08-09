import { describe, expect, test } from "bun:test";

import { restrictOutboundUrl } from "@/api/lib/restrict-outbound-url";

describe("provider-issued outbound URL restriction", () => {
  test("accepts only declared exact origins and path prefixes", () => {
    const allowed = restrictOutboundUrl({
      rawUrl: "https://court.example/api/document/123?format=json",
      hostPolicy: {
        type: "exact-origin",
        origins: ["https://court.example"],
      },
      pathPrefixes: ["/api/document/"],
    });

    expect(allowed?.toString()).toBe(
      "https://court.example/api/document/123?format=json",
    );
    expect(
      restrictOutboundUrl({
        rawUrl: "https://127.0.0.1/api/document/123",
        hostPolicy: {
          type: "exact-origin",
          origins: ["https://court.example"],
        },
        pathPrefixes: ["/api/document/"],
      }),
    ).toBeNull();
    expect(
      restrictOutboundUrl({
        rawUrl: "https://court.example/api/other/123",
        hostPolicy: {
          type: "exact-origin",
          origins: ["https://court.example"],
        },
        pathPrefixes: ["/api/document/"],
      }),
    ).toBeNull();
    expect(
      restrictOutboundUrl({
        rawUrl: "https://court.example/api/documentation/123",
        hostPolicy: {
          type: "exact-origin",
          origins: ["https://court.example"],
        },
        pathPrefixes: ["/api/document"],
      }),
    ).toBeNull();
  });

  test("accepts an HTTPS host only inside the declared domain family", () => {
    const policy = {
      type: "https-host-suffix" as const,
      suffixes: ["court.example"],
    };

    expect(
      restrictOutboundUrl({
        rawUrl: "https://documents.court.example/public/123",
        hostPolicy: policy,
      })?.hostname,
    ).toBe("documents.court.example");
    expect(
      restrictOutboundUrl({
        rawUrl: "https://court.example.attacker.invalid/public/123",
        hostPolicy: policy,
      }),
    ).toBeNull();
    expect(
      restrictOutboundUrl({
        rawUrl: "http://documents.court.example/public/123",
        hostPolicy: policy,
      }),
    ).toBeNull();
    expect(
      restrictOutboundUrl({
        rawUrl: "https://documents.court.example:8443/public/123",
        hostPolicy: policy,
      }),
    ).toBeNull();
  });

  test("rejects credentials and fragments", () => {
    const hostPolicy = {
      type: "exact-origin" as const,
      origins: ["https://court.example"],
    };

    expect(
      restrictOutboundUrl({
        rawUrl: "https://user:pass@court.example/document",
        hostPolicy,
      }),
    ).toBeNull();
    expect(
      restrictOutboundUrl({
        rawUrl: "https://court.example/document#private",
        hostPolicy,
      }),
    ).toBeNull();
  });
});
