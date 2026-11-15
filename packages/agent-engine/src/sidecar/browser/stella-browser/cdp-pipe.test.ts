import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { waitFor } from "@stll/test-kit";

import {
  connectCdpPipe,
  createCdpFrameReader,
  encodeCdpFrame,
} from "./cdp-pipe";

const bytes = (text: string) => new TextEncoder().encode(text);

const reader = (maxMessageBytes = 1024) => {
  const messages: string[] = [];
  const { push } = createCdpFrameReader({
    maxMessageBytes,
    onMessage: (json) => {
      messages.push(json);
    },
  });
  return { messages, read: push };
};

describe("the debugging pipe's framing", () => {
  test("a message is its JSON and one NUL byte", () => {
    expect([...encodeCdpFrame('{"id":1}')]).toEqual([...bytes('{"id":1}'), 0]);
  });

  test("joins a message split across reads, at any byte", () => {
    const frame = encodeCdpFrame('{"id":1,"result":{"text":"Grüße"}}');
    for (let cut = 0; cut <= frame.length; cut += 1) {
      const { messages, read } = reader();
      expect(read(frame.subarray(0, cut))).toBe(true);
      expect(read(frame.subarray(cut))).toBe(true);
      expect(messages).toEqual(['{"id":1,"result":{"text":"Grüße"}}']);
    }
  });

  test("keeps its own copy of a partial message when the caller reuses the Buffer", () => {
    const { messages, read } = reader();
    const chunk = Buffer.from('{"id":1');
    expect(read(chunk)).toBe(true);
    chunk[chunk.length - 1] = "2".codePointAt(0) ?? 0;
    expect(read(Buffer.from("}\0"))).toBe(true);
    expect(messages).toEqual(['{"id":1}']);
  });

  test("splits several messages in one read and keeps the rest for the next", () => {
    const { messages, read } = reader();
    expect(read(bytes('{"id":1}\0{"id":2}\0{"id"'))).toBe(true);
    expect(messages).toEqual(['{"id":1}', '{"id":2}']);
    expect(read(bytes(":3}\0"))).toBe(true);
    expect(messages).toEqual(['{"id":1}', '{"id":2}', '{"id":3}']);
  });

  test("refuses a message over the cap, whole or still arriving, and reads nothing after", () => {
    const whole = reader(8);
    expect(whole.read(bytes('{"id":12345}\0'))).toBe(false);
    expect(whole.read(bytes('{"id":1}\0'))).toBe(false);
    expect(whole.messages).toEqual([]);

    const arriving = reader(8);
    expect(arriving.read(bytes('{"id"'))).toBe(true);
    expect(arriving.read(bytes(":12345"))).toBe(false);
    expect(arriving.messages).toEqual([]);
  });
});

describe("connectCdpPipe", () => {
  const ends = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received: string[] = [];
    const pipe = connectCdpPipe(
      { input, output },
      {
        maxMessageBytes: 64,
        onMessage: (json) => {
          received.push(json);
        },
      },
    );
    return { input, output, pipe, received };
  };

  test("writes framed messages and reads the browser's", async () => {
    const { input, output, pipe, received } = ends();
    const written: Uint8Array[] = [];
    input.on("data", (chunk: Uint8Array) => {
      written.push(chunk);
    });
    expect(pipe.send('{"id":1}')).toBe(true);
    output.write(bytes('{"id":1,"result":{}}\0'));
    await waitFor(() => (received.length > 0 ? true : undefined), {
      description: "the browser's message",
      timeoutMs: 1000,
    });
    expect(Buffer.concat(written).toString()).toBe('{"id":1}\0');
    expect(received).toEqual(['{"id":1,"result":{}}']);
  });

  test("ends at the browser's end of file, and sends nothing after", async () => {
    const { output, pipe } = ends();
    output.end();
    expect(await pipe.ended).toEqual({ type: "end-of-file" });
    expect(pipe.send('{"id":2}')).toBe(false);
  });

  test("ends on a message over the cap", async () => {
    const { output, pipe, received } = ends();
    output.write(bytes(`{"id":1,"result":"${"x".repeat(100)}"}\0`));
    expect(await pipe.ended).toEqual({ type: "too-large" });
    expect(received).toEqual([]);
  });
});
