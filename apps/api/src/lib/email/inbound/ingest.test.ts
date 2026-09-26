import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { MailVerifier } from "@/api/lib/email/inbound/authentication";
import {
  ingestInboundMail,
  InboundPersistenceError,
  type InboundDeliveryOutcome,
  type InboundDeliveryStore,
  type PersistInboundDeliveryOptions,
} from "@/api/lib/email/inbound/ingest";

const token = "a".repeat(64);
const envelope = {
  mailFrom: "member@example.test",
  recipients: [`${token}@inbound.example.test`],
  remoteIp: "192.0.2.1",
  helo: "mail.example.test",
};
const receivedAt = "2026-09-26T12:00:00.000Z";
const fixture = async (name: string) =>
  new Uint8Array(
    await Bun.file(new URL(`fixtures/${name}`, import.meta.url)).arrayBuffer(),
  );
const verify: MailVerifier = async () =>
  Result.ok({
    source: "provider",
    evidence: "identifiers",
    fromDomain: "example.test",
    spf: { result: "pass", domain: "example.test", alignment: "strict" },
    dkim: [],
    dmarc: "pass",
  });

const memoryStore = () => {
  const records = new Map<string, { id: string; filers: Set<string> }>();
  const drops = new Map<string, string>();
  const deliveries: PersistInboundDeliveryOptions[] = [];
  const members = new Set(["member@example.test", "colleague@example.test"]);
  const persist: InboundDeliveryStore = async (input) => {
    deliveries.push(input);
    const { delivery } = input;
    if (delivery.status === "drop") {
      drops.set(`${input.token}:${input.deliveryKey}`, delivery.reason);
      return Result.ok({ status: "dropped" as const, reason: delivery.reason });
    }
    if (!members.has(delivery.sender)) {
      return Result.ok({
        status: "dropped" as const,
        reason: "unauthorized_sender" as const,
      });
    }
    // This fake models identity only; DB tests exercise correspondenceDedupKey.
    const key = JSON.stringify([
      input.token,
      delivery.message.intake,
      delivery.message.messageId,
      delivery.message.contentHash,
    ]);
    const existing = records.get(key);
    if (existing) {
      existing.filers.add(delivery.sender);
      return Result.ok({
        status: "duplicate" as const,
        correspondenceId: existing.id,
      });
    }
    const id = `record-${records.size + 1}`;
    records.set(key, { id, filers: new Set([delivery.sender]) });
    return Result.ok({ status: "filed" as const, correspondenceId: id });
  };
  return { persist, records, drops, members, deliveries };
};

const ingest = (raw: Uint8Array, persist: InboundDeliveryStore) =>
  ingestInboundMail({
    raw,
    envelope,
    receivedAt,
    inboundDomain: "inbound.example.test",
    verify,
    verifyOriginal: async () => Result.ok({ status: "unverified" as const }),
    scan: "pass",
    persist,
  });

describe("raw mail through the inbound filing boundary", () => {
  test("files member CC and preserves the member's outgoing message", async () => {
    const store = memoryStore();
    const result = await ingest(await fixture("member-cc.eml"), store.persist);
    expect(result.isOk()).toBe(true);
    expect(store.records.size).toBe(1);
    const delivery = store.deliveries.at(0)?.delivery;
    expect(delivery?.status).toBe("candidate");
    if (delivery?.status === "candidate") {
      expect(delivery.message.direction).toBe("out");
      expect(delivery.message.from.address).toBe("member@example.test");
      expect(delivery.message.intake).toBe("direct");
      expect(delivery.message.originalSignature).toBeNull();
      expect(delivery.message.authenticatedSender).toMatchObject({
        address: "member@example.test",
        dmarc: "pass",
      });
    }
  });

  test("replaying an original forwarded by two members converges to one message and both filers", async () => {
    const store = memoryStore();
    const original = await fixture("attached-forward.eml");
    const colleague = new TextEncoder().encode(
      new TextDecoder()
        .decode(original)
        .replace(
          "Member <member@example.test>",
          "Colleague <colleague@example.test>",
        ),
    );
    expect(new TextDecoder().decode(colleague)).not.toBe(
      new TextDecoder().decode(original),
    );
    for (const raw of [original, colleague, original, colleague]) {
      expect((await ingest(raw, store.persist)).isOk()).toBe(true);
    }
    expect(store.records.size).toBe(1);
    expect([...store.records.values()].at(0)?.filers).toEqual(
      new Set(["member@example.test", "colleague@example.test"]),
    );
    const delivery = store.deliveries.at(0)?.delivery;
    if (delivery?.status === "candidate") {
      expect(delivery.message.direction).toBe("in");
      expect(delivery.message.from.address).toBe("author@outside.test");
      expect(delivery.sender).toBe("member@example.test");
      expect(delivery.message.intake).toBe("forwarded_attachment");
      expect(delivery.message.originalSignature).toEqual({
        status: "unverified",
      });
      expect(delivery.message.authenticatedSender).toMatchObject({
        address: "member@example.test",
        dmarc: "pass",
      });
    }
  });

  test("a forged inline original keeps the outer sender's authentication separate", async () => {
    const store = memoryStore();
    const raw = new TextEncoder().encode(
      [
        "From: Member <member@example.test>",
        "To: Matter <matter@example.test>",
        "Subject: Fwd: Court order",
        "Date: Sat, 26 Sep 2026 12:00:00 +0000",
        "Message-ID: <forged-wrapper@example.test>",
        "Content-Type: text/plain; charset=UTF-8",
        "",
        "Please file this order.",
        "",
        "---------- Forwarded message ---------",
        "From: Court <judge@court.test>",
        "Date: Fri, 25 Sep 2026 11:00:00 +0000",
        "Subject: Court order",
        "To: Member <member@example.test>",
        "",
        "This is a forged order.",
      ].join("\r\n"),
    );
    const result = await ingestInboundMail({
      raw,
      envelope,
      receivedAt,
      inboundDomain: "inbound.example.test",
      verify,
      verifyOriginal: async () => {
        throw new DOMException(
          "inline content must not be signature checked",
          "InvalidStateError",
        );
      },
      scan: "pass",
      persist: store.persist,
    });
    expect(result.isOk()).toBe(true);
    const delivery = store.deliveries.at(0)?.delivery;
    expect(delivery?.status).toBe("candidate");
    if (delivery?.status === "candidate") {
      expect(delivery.message.intake).toBe("forwarded_inline");
      expect(delivery.message.from.address).toBe("judge@court.test");
      expect(delivery.message.bodyText).toBe("This is a forged order.");
      expect(delivery.message.originalSignature).toEqual({
        status: "unverified",
      });
      expect(delivery.message.authenticatedSender).toMatchObject({
        address: "member@example.test",
        alignedIdentifier: "example.test",
        dmarc: "pass",
      });
    }
  });

  test("a validly authenticated counterparty reply-all is rejected by the membership boundary", async () => {
    const store = memoryStore();
    store.members.clear();
    const result = await ingest(await fixture("member-cc.eml"), store.persist);
    expect(result.isOk() && result.value).toEqual([
      { status: "dropped", reason: "unauthorized_sender" },
    ] satisfies InboundDeliveryOutcome[]);
    expect(store.records.size).toBe(0);
  });

  test("forged From is a terminal replay-safe drop without retaining message content", async () => {
    const store = memoryStore();
    const raw = await fixture("forged-from.eml");
    await ingest(raw, store.persist);
    await ingest(raw, store.persist);
    expect(store.drops.size).toBe(1);
    expect(store.deliveries.at(0)?.delivery).toEqual({
      status: "drop",
      sender: null,
      reason: "malformed_message",
    });
  });

  test("domains without DMARC cannot file and the store sees only a minimal drop", async () => {
    const store = memoryStore();
    const result = await ingestInboundMail({
      raw: await fixture("member-cc.eml"),
      envelope,
      receivedAt,
      inboundDomain: "inbound.example.test",
      scan: "pass",
      persist: store.persist,
      verify: async (options) => {
        const verdict = await verify(options);
        return verdict.map((auth) =>
          Object.assign(auth, { dmarc: "none" as const }),
        );
      },
    });
    expect(result.isOk()).toBe(true);
    expect(store.records.size).toBe(0);
    expect(store.deliveries.at(0)?.delivery).toEqual({
      status: "drop",
      sender: "member@example.test",
      reason: "authentication_failed",
    });
  });

  test("a retryable store failure does not claim a terminal outcome", async () => {
    const result = await ingest(await fixture("member-cc.eml"), async () =>
      Result.err(
        new InboundPersistenceError({ message: "Storage unavailable" }),
      ),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.reason).toBe("persistence-unavailable");
    }
  });

  test("unknown recipient domains cause no parsing, authentication, or persistence", async () => {
    const store = memoryStore();
    const result = await ingestInboundMail({
      raw: new Uint8Array(),
      envelope: { ...envelope, recipients: [`${token}@other.test`] },
      receivedAt,
      inboundDomain: "inbound.example.test",
      verify: async () => {
        throw new DOMException("must not verify", "InvalidStateError");
      },
      scan: "pass",
      persist: store.persist,
    });
    expect(result.isOk()).toBe(true);
    expect(store.deliveries).toHaveLength(0);
  });
});

test("unavailable authentication or scanning cannot become a terminal delivery", async () => {
  const raw = await fixture("member-cc.eml");
  for (const unavailable of ["spf", "dkim", "dmarc", "scan"] as const) {
    const store = memoryStore();
    const result = await ingestInboundMail({
      raw,
      envelope,
      receivedAt,
      inboundDomain: "inbound.example.test",
      scan: unavailable === "scan" ? "unavailable" : "pass",
      persist: store.persist,
      verify: async () =>
        Result.ok({
          source: "local",
          evidence: "identifiers",
          fromDomain: "example.test",
          spf: {
            result: unavailable === "spf" ? "temperror" : "pass",
            domain: "example.test",
            alignment: "strict",
          },
          dkim: [
            {
              result: unavailable === "dkim" ? "temperror" : "none",
              domain: "example.test",
              alignment: "strict",
            },
          ],
          dmarc: (
            {
              spf: "fail",
              dkim: "fail",
              dmarc: "temperror",
              scan: "pass",
            } as const
          )[unavailable],
        }),
    });
    expect(result.isErr()).toBe(true);
    expect(store.deliveries).toHaveLength(0);
    expect(store.records.size).toBe(0);
  }
});
