import { describe, expect, test } from "bun:test";

import { createSubmitIntent } from "./idempotent-submit.logic";

describe("idempotent submit intent", () => {
  test("retries retain the key and success or reset starts a new intent", () => {
    let sequence = 0;
    const intent = createSubmitIntent(() => String(++sequence));
    const first = intent.request().headers["Idempotency-Key"];
    expect(intent.request().headers["Idempotency-Key"]).toBe(first);
    intent.complete(first);
    const next = intent.request().headers["Idempotency-Key"];
    expect(next).not.toBe(first);
    expect(intent.request().headers["Idempotency-Key"]).toBe(next);
    intent.reset();
    expect(intent.request().headers["Idempotency-Key"]).not.toBe(next);
  });

  test("completion of an old request preserves a newer intent", () => {
    let sequence = 0;
    const intent = createSubmitIntent(() => String(++sequence));
    const first = intent.request().headers["Idempotency-Key"];
    intent.reset();
    const next = intent.request().headers["Idempotency-Key"];
    intent.complete(first);
    expect(intent.request().headers["Idempotency-Key"]).toBe(next);
  });
  test("edited submissions start a new intent after a failed attempt", () => {
    let sequence = 0;
    const intent = createSubmitIntent(() => String(++sequence));
    const first = intent.request("first payload").headers["Idempotency-Key"];
    expect(intent.request("first payload").headers["Idempotency-Key"]).toBe(
      first,
    );
    expect(
      intent.request("edited payload").headers["Idempotency-Key"],
    ).not.toBe(first);
  });
  test("interleaved submissions retain each failed intent independently", () => {
    let sequence = 0;
    const intent = createSubmitIntent(() => String(++sequence));
    const first = intent.request("first payload").headers["Idempotency-Key"];
    const second = intent.request("second payload").headers["Idempotency-Key"];
    expect(second).not.toBe(first);
    expect(intent.request("first payload").headers["Idempotency-Key"]).toBe(
      first,
    );
    intent.complete(second);
    expect(intent.request("first payload").headers["Idempotency-Key"]).toBe(
      first,
    );
    expect(
      intent.request("second payload").headers["Idempotency-Key"],
    ).not.toBe(second);
  });
});
