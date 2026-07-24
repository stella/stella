import { describe, expect, test } from "bun:test";

import { sanitizeFeedbackText } from "../feedback-sanitize";

describe("sanitizeFeedbackText", () => {
  const cases: {
    name: string;
    input: string;
    expected: string;
    redactions: number;
  }[] = [
    {
      name: "plain email",
      input: "Contact jane.doe@example.com for details.",
      expected: "Contact [redacted-email] for details.",
      redactions: 1,
    },
    {
      name: "canonical UUID",
      input: "matter 550e8400-e29b-41d4-a716-446655440000 failed",
      expected: "matter [redacted-id] failed",
      redactions: 1,
    },
    {
      name: "JWT-looking blob",
      input:
        "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w2n done", // gitleaks:allow -- fake JWT fixture exercising the sanitizer's redaction
      expected: "token [redacted-secret] done",
      redactions: 1,
    },
    {
      name: "long hex secret",
      input: "key deadbeefdeadbeefdeadbeefdeadbeef00 leaked",
      expected: "key [redacted-secret] leaked",
      redactions: 1,
    },
    {
      name: "long base64 token",
      input:
        "bearer AKIAIOSFODNN7EXAMPLEwJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY here",
      expected: "bearer [redacted-secret] here",
      redactions: 1,
    },
    {
      name: "non-allowlisted URL",
      input: "see https://internal.acme.example/dashboard?tab=1 now",
      expected: "see [redacted-url] now",
      redactions: 1,
    },
    {
      name: "non-allowlisted URL keeps trailing period",
      input: "open https://secret.example.com/path.",
      expected: "open [redacted-url].",
      redactions: 1,
    },
    {
      name: "non-allowlisted URL redacts parenthesized path text",
      input: "open https://internal.example/matter(Acme-Secret)/token",
      expected: "open [redacted-url]",
      redactions: 1,
    },
    {
      name: "wrapped URL keeps its closing wrapper",
      input: "see (https://internal.example/path)",
      expected: "see ([redacted-url])",
      redactions: 1,
    },
    {
      name: "allowlisted github URL is preserved",
      input: "repo at https://github.com/stella/anonymize works",
      expected: "repo at https://github.com/stella/anonymize works",
      redactions: 0,
    },
    {
      name: "a different stella repo URL is redacted",
      input: "see https://github.com/stella/stella for context",
      expected: "see [redacted-url] for context",
      redactions: 1,
    },
    {
      name: "private github URL is redacted",
      input: "customer repro at https://github.com/customer/private-matter",
      expected: "customer repro at [redacted-url]",
      redactions: 1,
    },
    {
      name: "github URL with query data is redacted",
      input:
        "repo link https://github.com/stella/anonymize/issues?customer=acme",
      expected: "repo link [redacted-url]",
      redactions: 1,
    },
    {
      name: "UUID inside an allowlisted URL path is still redacted",
      input:
        "https://github.com/stella/anonymize/issues/550e8400-e29b-41d4-a716-446655440000",
      expected: "https://github.com/stella/anonymize/issues/[redacted-id]",
      redactions: 1,
    },
    {
      name: "email inside a non-allowlisted URL collapses to a redacted URL",
      input: "link https://x.example/u/jane@example.com/profile end",
      expected: "link [redacted-url] end",
      redactions: 1,
    },
    {
      name: "IPv4 literal",
      input: "host 192.168.1.254 unreachable",
      expected: "host [redacted-ip] unreachable",
      redactions: 1,
    },
    {
      name: "full-form IPv6 literal",
      input: "peer 2001:0db8:85a3:0000:0000:8a2e:0370:7334 down",
      expected: "peer [redacted-ip] down",
      redactions: 1,
    },
    {
      name: "compressed IPv6 literal",
      input: "gateway fe80::1 timed out",
      expected: "gateway [redacted-ip] timed out",
      redactions: 1,
    },
    {
      name: "markdown code fences are preserved while a secret inside is redacted",
      input:
        "Repro:\n```\nexport TOKEN=deadbeefdeadbeefdeadbeefdeadbeef99\n```\ndone",
      expected: "Repro:\n```\nexport TOKEN=[redacted-secret]\n```\ndone",
      redactions: 1,
    },
    {
      name: "clean text is untouched",
      input: "anonymize_text_file rejects a path outside the configured root",
      expected:
        "anonymize_text_file rejects a path outside the configured root",
      redactions: 0,
    },
    {
      name: "version strings and short dotted numbers are not treated as secrets or IPs",
      input: "seen on v1.2.3 and step 1.2.3",
      expected: "seen on v1.2.3 and step 1.2.3",
      redactions: 0,
    },
    {
      name: "multiple redactions are counted",
      input: "a@b.com and c@d.org and 10.0.0.1",
      expected: "[redacted-email] and [redacted-email] and [redacted-ip]",
      redactions: 3,
    },
  ];

  for (const { expected, input, name, redactions } of cases) {
    test(name, () => {
      const result = sanitizeFeedbackText(input);
      expect(result.text).toBe(expected);
      expect(result.redactions).toBe(redactions);
    });
  }

  test("does not misread a C++ scope resolution as an IPv6 address", () => {
    const result = sanitizeFeedbackText("crash in std::vector::push_back");
    expect(result.text).toBe("crash in std::vector::push_back");
    expect(result.redactions).toBe(0);
  });
});
