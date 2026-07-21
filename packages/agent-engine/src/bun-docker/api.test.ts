import { describe, expect, test } from "bun:test";

import { demuxExecStream, DockerApiError } from "./api";

const dockerFrame = (streamType: number, payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = streamType;
  new DataView(frame.buffer).setUint32(4, payload.length, false);
  frame.set(payload, 8);
  return frame;
};

const streamChunks = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

const collectFrames = async (stream: ReadableStream<Uint8Array>) => {
  const frames = [];
  for await (const frame of demuxExecStream(stream)) {
    frames.push(frame);
  }
  return frames;
};

describe("Docker exec stream demultiplexing", () => {
  test("reassembles fragmented headers and payloads without losing bytes", async () => {
    const encoder = new TextEncoder();
    const stdoutFrame = dockerFrame(1, encoder.encode("hello"));
    const stderrFrame = dockerFrame(2, encoder.encode("warning"));
    const bytes = new Uint8Array(stdoutFrame.length + stderrFrame.length);
    bytes.set(stdoutFrame);
    bytes.set(stderrFrame, stdoutFrame.length);

    const frames = await collectFrames(
      streamChunks([
        bytes.slice(0, 3),
        bytes.slice(3, 11),
        bytes.slice(11, 19),
        bytes.slice(19),
      ]),
    );

    expect(
      frames.map(({ stream, data }) => [
        stream,
        new TextDecoder().decode(data),
      ]),
    ).toEqual([
      ["stdout", "hello"],
      ["stderr", "warning"],
    ]);
  });

  test("rejects an invalid Docker stream discriminator", async () => {
    const operation = collectFrames(
      streamChunks([dockerFrame(3, new TextEncoder().encode("bad"))]),
    );

    expect(operation).rejects.toBeInstanceOf(DockerApiError);
  });

  test("rejects a truncated final frame", async () => {
    const frame = dockerFrame(1, new TextEncoder().encode("partial"));
    const operation = collectFrames(streamChunks([frame.slice(0, -1)]));

    expect(operation).rejects.toBeInstanceOf(DockerApiError);
  });
});
