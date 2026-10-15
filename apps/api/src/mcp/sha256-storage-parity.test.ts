import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";

import type { FeedbackReportInput } from "@stll/api-contract/feedback";
import { sha256Base64Url, sha256Hex } from "@stll/sha256/node";

import { decisionTextVersion } from "./case-law-decision-read";
import {
  createFeedbackApproval,
  FEEDBACK_APPROVAL_TTL_MS,
} from "./feedback-approval";
import { createRequestIdFor } from "./reader-annotation-tools";
import { fingerprintTemplatePersistenceRequest } from "./template-persistence";

// Independent Node-owner digests retain the old createHash recipes.
for (const text of [
  "",
  "abc",
  "Příliš žluťoučký kůň 📄 中文\u0000\ud800",
  "e\u0301",
]) {
  test(`decision paging versions retain Base64URL truncation: ${JSON.stringify(text)}`, () => {
    expect(decisionTextVersion(text)).toBe(sha256Base64Url(text).slice(0, 12));
  });

  test(`template idempotency identities retain sorted object keys and array order: ${JSON.stringify(text)}`, () => {
    const input = { z: text, a: { y: null, x: [1, false, text] } };
    const canonical = JSON.stringify({
      a: { x: [1, false, text], y: null },
      z: text,
    });
    expect(fingerprintTemplatePersistenceRequest(input)).toBe(
      sha256Hex(canonical),
    );
    expect(fingerprintTemplatePersistenceRequest(text)).toBe(
      sha256Hex(JSON.stringify(text)),
    );
  });

  test(`feedback approvals retain the report digest inside the unchanged HMAC: ${JSON.stringify(text)}`, () => {
    const report = {
      title: text,
      whatHappened: text,
      kind: "bug",
      area: "documents",
    } as const satisfies FeedbackReportInput;
    const canonical = JSON.stringify({
      area: "documents",
      kind: "bug",
      title: text,
      whatHappened: text,
    });
    const now = 1_800_000_000_000;
    const expiresAt = now + FEEDBACK_APPROVAL_TTL_MS;
    const secret = "sha256-parity-fixture-secret";
    const signature = createHmac("sha256", secret)
      .update(
        [
          "fb1",
          "user_1",
          "org_1",
          String(expiresAt),
          sha256Base64Url(canonical),
        ].join(":"),
      )
      .digest("base64url");
    expect(
      createFeedbackApproval({
        organizationId: "org_1",
        userId: "user_1",
        secret,
        report,
        now,
      }),
    ).toBe(`fb1.${String(expiresAt)}.${signature}`);
  });

  test(`reader mark request identities retain tenant tuple order and UUID bits: ${JSON.stringify(text)}`, () => {
    const request = {
      mark: { kind: "comment", body: text },
      spans: [],
      target_id: "target",
      target_type: "case_law_decision",
      visibility: "private",
    };
    const hex = sha256Hex(JSON.stringify(["org_1", "user_1", request])).slice(
      0,
      32,
    );
    const variant = (8 + (Number.parseInt(hex.charAt(16), 16) % 4)).toString(
      16,
    );
    const versioned = `${hex.slice(0, 12)}8${hex.slice(13, 16)}${variant}${hex.slice(17)}`;
    const expected = `${versioned.slice(0, 8)}-${versioned.slice(8, 12)}-${versioned.slice(12, 16)}-${versioned.slice(16, 20)}-${versioned.slice(20)}`;
    expect(
      String(
        createRequestIdFor({
          organizationId: "org_1",
          userId: "user_1",
          request,
        }),
      ),
    ).toBe(expected);
  });
}
