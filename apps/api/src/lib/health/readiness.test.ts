import { afterAll, describe, expect, test } from "bun:test";

import type {
  ReadinessDependency,
  ReadinessProbes,
} from "@/api/lib/health/readiness";

/** The commands the fake server below has been asked to answer. */
const receivedCommands: string[] = [];

// A RESP3 server that answers the handshake and PING and nothing else. The
// Redis probe only means something when a real Bun client runs it (see
// `probeRedis`), and a real client needs a real socket to speak to.
const fakeRedis = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    data: (socket, data) => {
      // Every command here is argument-free, so each bulk string in the frame
      // is a command name.
      for (const line of data.toString().split("\r\n")) {
        if (line === "HELLO") {
          receivedCommands.push(line);
          socket.write("%1\r\n$6\r\nserver\r\n$4\r\nfake\r\n");
        } else if (line === "PING") {
          receivedCommands.push(line);
          socket.write("+PONG\r\n");
        }
      }
    },
  },
});

// Read at import by the connection module the probe builds its client through.
process.env["REDIS_URL"] = `redis://127.0.0.1:${fakeRedis.port}`;

const {
  API_READINESS_DEPENDENCIES,
  READINESS_DEPENDENCY,
  probeObjectStorageReadiness,
  probeRedis,
  runReadinessProbes,
} = await import("@/api/lib/health/readiness");

afterAll(() => {
  fakeRedis.stop(true);
});

const successfulProbes = (calls: ReadinessDependency[]): ReadinessProbes => ({
  [READINESS_DEPENDENCY.database]: async () => {
    calls.push(READINESS_DEPENDENCY.database);
  },
  [READINESS_DEPENDENCY.documentConverter]: async () => {
    calls.push(READINESS_DEPENDENCY.documentConverter);
  },
  [READINESS_DEPENDENCY.objectStorage]: async () => {
    calls.push(READINESS_DEPENDENCY.objectStorage);
  },
  [READINESS_DEPENDENCY.redis]: async () => {
    calls.push(READINESS_DEPENDENCY.redis);
  },
  [READINESS_DEPENDENCY.scheduledJobs]: async () => {
    calls.push(READINESS_DEPENDENCY.scheduledJobs);
  },
});

describe("the Redis readiness probe", () => {
  test("sends its command on the connection it has just opened", async () => {
    // The probe builds a client and sends PING at once, with no connect() in
    // between: the command is issued while the socket and the RESP handshake
    // are still in flight. That is the shape of every "create then send" call
    // site, and a client that rejects such a command reports the dependency
    // as unavailable for as long as the process runs.
    await probeRedis(new AbortController().signal);

    expect(receivedCommands).toContain("PING");
  });
});

describe("API dependency readiness", () => {
  test("provisions a readable marker without requiring bucket listing", async () => {
    const calls: string[] = [];
    let markerExists = false;

    await probeObjectStorageReadiness(
      {
        read: async () => {
          calls.push("read");
          if (!markerExists) {
            throw Object.assign(new Error("Access denied"), {
              name: "AccessDenied",
            });
          }
        },
        write: async () => {
          calls.push("write");
          markerExists = true;
        },
      },
      new AbortController().signal,
    );

    expect(calls).toEqual(["read", "write", "read"]);
  });

  test("reads an existing marker without rewriting it", async () => {
    const calls: string[] = [];
    await probeObjectStorageReadiness(
      {
        read: async () => {
          calls.push("read");
        },
        write: async () => {
          calls.push("write");
        },
      },
      new AbortController().signal,
    );
    expect(calls).toEqual(["read"]);
  });

  test("exercises the declared dependency set in both directions", async () => {
    const calls: ReadinessDependency[] = [];
    expect(await runReadinessProbes(successfulProbes(calls))).toEqual({
      status: "ready",
    });
    expect(calls.toSorted()).toEqual(API_READINESS_DEPENDENCIES.toSorted());
  });

  test.each(API_READINESS_DEPENDENCIES)(
    "reports a failed production dependency: %s",
    async (failedDependency) => {
      const calls: ReadinessDependency[] = [];
      const probes = successfulProbes(calls);
      probes[failedDependency] = async () => {
        calls.push(failedDependency);
        throw new Error("production dependency unavailable");
      };

      expect(await runReadinessProbes(probes)).toEqual({
        status: "not-ready",
        failed: [failedDependency],
      });
      expect(calls.toSorted()).toEqual(API_READINESS_DEPENDENCIES.toSorted());
    },
  );
});
