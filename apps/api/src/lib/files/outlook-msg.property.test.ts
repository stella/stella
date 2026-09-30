import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { OutlookMsgParseError, parseOutlookMsg } from "./outlook-msg";

const END_OF_CHAIN = 0xff_ff_ff_fe;
const NO_STREAM = 0xff_ff_ff_ff;
const SECTOR_BYTES = 512;

const emptyMessage = () => {
  const bytes = new Uint8Array(SECTOR_BYTES * 3);
  const view = new DataView(bytes.buffer);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x00_3e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xff_fe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, 1, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, END_OF_CHAIN, true);
  view.setUint32(68, END_OF_CHAIN, true);
  for (let offset = 76; offset < SECTOR_BYTES; offset += 4) {
    view.setUint32(offset, NO_STREAM, true);
  }
  view.setUint32(76, 0, true);
  for (let offset = SECTOR_BYTES; offset < SECTOR_BYTES * 2; offset += 4) {
    view.setUint32(offset, NO_STREAM, true);
  }
  view.setUint32(SECTOR_BYTES, 0xff_ff_ff_fd, true);
  view.setUint32(SECTOR_BYTES + 4, END_OF_CHAIN, true);
  const root = SECTOR_BYTES * 2;
  const name = "Root Entry\0";
  bytes.set(Buffer.from(name, "utf16le"), root);
  view.setUint16(root + 64, name.length * 2, true);
  bytes[root + 66] = 5;
  bytes[root + 67] = 1;
  view.setUint32(root + 68, NO_STREAM, true);
  view.setUint32(root + 72, NO_STREAM, true);
  view.setUint32(root + 76, NO_STREAM, true);
  view.setUint32(root + 116, END_OF_CHAIN, true);
  return bytes;
};
const mutatedMessage = fc
  .array(
    fc.record({
      offset: fc.integer({ min: 0, max: SECTOR_BYTES * 3 - 1 }),
      value: fc.integer({ min: 0, max: 255 }),
    }),
    { maxLength: 16 },
  )
  .map((mutations) => {
    const bytes = emptyMessage();
    for (const { offset, value } of mutations) {
      bytes[offset] = value;
    }
    return bytes;
  });

describe("Outlook message properties", () => {
  test("valid empty storage reaches message decoding", () => {
    const parsed = parseOutlookMsg(emptyMessage().buffer);
    expect(parsed.subject).toBeNull();
    expect(parsed.attachments).toEqual([]);
    expect(parsed.to).toEqual([]);
  });

  test(
    "arbitrary and mutated storage yields only typed failures within budget",
    () => {
      fc.assert(
        fc.property(
          fc.oneof(fc.uint8Array({ maxLength: 4096 }), mutatedMessage),
          (bytes) => {
            const start = performance.now();
            const result = Result.try({
              try: () => parseOutlookMsg(new Uint8Array(bytes).buffer),
              catch: (error) => error,
            });
            expect(performance.now() - start).toBeLessThan(2000);
            if (result.isErr()) {
              expect(result.error).toBeInstanceOf(OutlookMsgParseError);
              return;
            }
            expect(
              result.value.attachments.every(
                ({ bytes: content }) => content instanceof Uint8Array,
              ),
            ).toBe(true);
            expect(result.value.to.every(({ type }) => type === "to")).toBe(
              true,
            );
            expect(result.value.cc.every(({ type }) => type === "cc")).toBe(
              true,
            );
            expect(result.value.bcc.every(({ type }) => type === "bcc")).toBe(
              true,
            );
          },
        ),
        propertyConfig({ seed: propertySeed() }),
      );
    },
    propertyTestTimeout(15_000),
  );
});
