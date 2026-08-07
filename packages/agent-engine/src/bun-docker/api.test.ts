import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import {
  createContainer,
  demuxExecStream,
  DockerApiError,
  imageExists,
  pullImage,
  UserDefinedDockerNetwork,
} from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

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

describe("Docker container isolation", () => {
  test("rejects built-in, shared, empty, and malformed network modes", () => {
    for (const mode of [
      "",
      " ",
      "bridge",
      "DEFAULT",
      "host",
      "none",
      "container:peer",
      " stella-private",
    ]) {
      expect(() => UserDefinedDockerNetwork.parse(mode)).toThrow(
        /safe user-defined network/u,
      );
    }
  });

  test("accepts an explicit user-defined network name", () => {
    expect(
      UserDefinedDockerNetwork.parse("stella-egress_restricted.v1").name,
    ).toBe("stella-egress_restricted.v1");
  });

  test("creates containers with bounded compute and writable filesystems", async () => {
    let requestBody: unknown;
    globalThis.fetch = Object.assign(
      mock(async (_url, init) => {
        requestBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return new Response(JSON.stringify({ Id: "container-1" }), {
          headers: { "Content-Type": "application/json" },
          status: 201,
        });
      }),
      { preconnect: originalFetch.preconnect.bind(originalFetch) },
    );

    await createContainer(
      { socketPath: "/var/run/docker.sock" },
      {
        cmd: ["sleep", "infinity"],
        hostGateway: false,
        image: "stella/agent-sandbox:test",
        networkMode: UserDefinedDockerNetwork.parse("stella-private"),
        workdir: "/workspace",
      },
    );

    expect(requestBody).toMatchObject({
      HostConfig: {
        CapDrop: ["ALL"],
        Memory: 2_147_483_648,
        NanoCpus: 2_000_000_000,
        NetworkMode: "stella-private",
        PidsLimit: 256,
        ReadonlyRootfs: true,
        SecurityOpt: ["no-new-privileges"],
        Tmpfs: {
          "/home/agent": expect.stringContaining("size=256m"),
          "/tmp": expect.stringContaining("size=256m"),
          "/workspace": expect.stringContaining("size=1g"),
        },
      },
    });
  });

  test("gives cold image pulls a longer timeout than ordinary daemon calls", async () => {
    const timeouts: number[] = [];
    spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      timeouts.push(milliseconds);
      return new AbortController().signal;
    });
    globalThis.fetch = Object.assign(
      mock(async (input) =>
        String(input).includes("/images/create")
          ? new Response('{"status":"done"}\n')
          : new Response(null, { status: 404 }),
      ),
      { preconnect: originalFetch.preconnect.bind(originalFetch) },
    );

    await imageExists({ socketPath: "/var/run/docker.sock" }, "sandbox:test");
    await pullImage({ socketPath: "/var/run/docker.sock" }, "sandbox:test");

    expect(timeouts).toEqual([30_000, 600_000]);
  });
});
