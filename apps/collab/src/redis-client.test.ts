import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import { panic, Result } from "better-result";
import { expect, spyOn, test } from "bun:test";
import RedisClient, { Command } from "ioredis";

import {
  StoreUnavailableError,
  type StorePolicyStatus,
} from "@stll/redis-config/store-policy";

import { createCollabRedisClient } from "./redis-client";

const expectStoreRefusal = async (command: Promise<unknown>) => {
  const result = await Result.tryPromise({
    try: async () => await command,
    catch: (error: unknown) => error,
  });
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toBeInstanceOf(StoreUnavailableError);
  }
};

test.each(["cache", "durable-coordination"] as const)(
  "%s collaboration clients retain URL, credentials and TLS options through duplication",
  (storeClass) => {
    const client = createCollabRedisClient({
      redisUrl: "rediss://user:p%40ss@redis.example.test:6380/4",
      rejectUnauthorized: false,
      storeClass,
    });
    const clone = client.duplicate({ db: 7, enableOfflineQueue: false });
    try {
      const sharedOptions = {
        host: "redis.example.test",
        port: 6380,
        username: "user",
        password: "p@ss",
        tls: { rejectUnauthorized: false },
        lazyConnect: true,
      };
      expect(client.options).toMatchObject({ ...sharedOptions, db: 4 });
      expect(clone.options).toMatchObject({
        ...sharedOptions,
        db: 7,
        enableOfflineQueue: false,
      });
    } finally {
      clone.disconnect();
      client.disconnect();
    }
  },
);

test("collaboration clients apply enforced authentication and TLS settings at construction", () => {
  const client = createCollabRedisClient({
    redisUrl: "rediss://redis.example.test:6380/3",
    rejectUnauthorized: false,
    storeClass: "durable-coordination",
    settings: {
      REDIS_CONNECTION_ENFORCED: true,
      REDIS_USERNAME: "service",
      REDIS_PASSWORD: "example-value",
      REDIS_TLS_CA_PEM: "example-ca",
      REDIS_TLS_SERVER_NAME: "redis.example.test",
    },
  });
  try {
    expect(client.options).toMatchObject({
      host: "redis.example.test",
      port: 6380,
      db: 3,
      username: "service",
      password: "example-value",
      tls: {
        ca: "example-ca",
        servername: "redis.example.test",
        rejectUnauthorized: true,
      },
      lazyConnect: true,
    });
  } finally {
    client.disconnect();
  }
});

test("collaboration coordination commands require an allowed store policy", async () => {
  const sent: string[] = [];
  let policy = "allkeys-lru";
  const observed: StorePolicyStatus[] = [];
  const send = spyOn(RedisClient.prototype, "sendCommand").mockImplementation(
    async (command) => {
      sent.push(command.name);
      command.resolve(
        command.name === "info" ? `maxmemory_policy:${policy}\r\n` : "OK",
      );
      return command.promise;
    },
  );
  const client = createCollabRedisClient({
    redisUrl: "redis://localhost:6379",
    storeClass: "durable-coordination",
    onPolicyStatus: (status) => {
      observed.push(status);
    },
  });
  try {
    await expectStoreRefusal(client.eval("return 1", 0));
    expect(sent).toEqual(["info"]);
    const callbackError = await new Promise<Error | null | undefined>(
      (resolve) => {
        void client.eval("return 1", 0, (error) => resolve(error));
      },
    );
    expect(callbackError).toBeInstanceOf(StoreUnavailableError);
    expect(sent).toEqual(["info"]);
    const clone = client.duplicate();
    try {
      await expectStoreRefusal(clone.eval("return 1", 0));
      const results = await clone.pipeline().eval("return 1", 0).exec();
      expect(results?.at(0)?.at(0)).toBeInstanceOf(StoreUnavailableError);
    } finally {
      clone.disconnect();
    }
    sent.length = 0;
    policy = "noeviction";
    client.emit("close");
    expect(await client.eval("return 1", 0)).toBe("OK");
    expect(sent).toEqual(["info", "eval"]);
    policy = "allkeys-lru";
    client.emit("close");
    await expectStoreRefusal(client.eval("return 1", 0));
    expect(sent).toEqual(["info", "eval", "info"]);
    expect(observed).toEqual(["refused", "refused", "allowed", "refused"]);
  } finally {
    client.disconnect();
    send.mockRestore();
  }
});

test("the collaboration extension consumes publishing before subscription clients", async () => {
  const sent: string[] = [];
  const send = spyOn(RedisClient.prototype, "sendCommand").mockImplementation(
    async (command) => {
      sent.push(command.name);
      command.resolve(
        command.name === "info" ? "maxmemory_policy:allkeys-lru\r\n" : 1,
      );
      return command.promise;
    },
  );
  const clients = {
    publish: createCollabRedisClient({
      redisUrl: "redis://localhost:6379",
      storeClass: "durable-coordination",
    }),
    subscribe: createCollabRedisClient({
      redisUrl: "redis://localhost:6379",
      storeClass: "cache",
    }),
  };
  const pending = [clients.publish, clients.subscribe];
  try {
    const extension = new RedisExtension({
      createClient: () =>
        pending.shift() ?? panic("Unexpected collaboration client request"),
    });
    expect(extension.pub).toBe(clients.publish);
    expect(extension.sub).toBe(clients.subscribe);
    expect(pending).toEqual([]);
    await clients.subscribe.ping();
    expect(sent).toContain("subscribe");
    expect(sent).not.toContain("info");
    await expectStoreRefusal(clients.publish.eval("return 1", 0));
    expect(sent).not.toContain("eval");
    expect(await clients.subscribe.subscribe("another-channel")).toBe(1);
  } finally {
    clients.publish.disconnect();
    clients.subscribe.disconnect();
    send.mockRestore();
  }
});

test("cache clients deliver commands without policy inspection", async () => {
  const sent: string[] = [];
  const send = spyOn(RedisClient.prototype, "sendCommand").mockImplementation(
    async (command) => {
      sent.push(command.name);
      command.resolve(1);
      return command.promise;
    },
  );
  const client = createCollabRedisClient({
    redisUrl: "redis://localhost:6379",
    storeClass: "cache",
  });
  try {
    expect(await client.publish("channel", "message")).toBe(1);
    expect(sent).toEqual(["publish"]);
  } finally {
    client.disconnect();
    send.mockRestore();
  }
});

test("driver handshakes remain available before command policy inspection", async () => {
  const sent: string[] = [];
  const send = spyOn(RedisClient.prototype, "sendCommand").mockImplementation(
    async (command) => {
      sent.push(command.name);
      command.resolve(
        command.name === "info" ? "maxmemory_policy:allkeys-lru\r\n" : "OK",
      );
      return command.promise;
    },
  );
  const client = createCollabRedisClient({
    redisUrl: "redis://localhost:6379",
    storeClass: "durable-coordination",
  });
  try {
    expect(await client.sendCommand(new Command("auth", ["example"]))).toBe(
      "OK",
    );
    expect(sent).toEqual(["auth"]);
    await expectStoreRefusal(client.eval("return 1", 0));
    expect(sent).toEqual(["auth", "info"]);
  } finally {
    client.disconnect();
    send.mockRestore();
  }
});

const redisTestUrl = process.env["STELLA_COLLAB_TEST_REDIS_URL"];

test.skipIf(redisTestUrl === undefined)(
  "real collaboration clients decode and enforce policy observations",
  async () => {
    if (redisTestUrl === undefined) {
      panic("Redis test URL is required");
    }
    const statuses: string[] = [];
    const errors: unknown[] = [];
    const client = createCollabRedisClient({
      redisUrl: redisTestUrl,
      storeClass: "durable-coordination",
      onPolicyStatus: (status) => {
        statuses.push(status);
      },
    });
    client.on("error", (error) => {
      errors.push(error);
    });
    const original = RedisClient.prototype.sendCommand;
    let reported = "noeviction";
    const send = spyOn(RedisClient.prototype, "sendCommand").mockImplementation(
      function (this: RedisClient, command, ...args) {
        const reply: unknown = original.call(this, command, ...args);
        if (command.name !== "info" || !command.args.includes("memory")) {
          return reply;
        }
        return Promise.resolve(reply).then((value: unknown) => {
          expect(typeof value).toBe("string");
          if (typeof value !== "string") {
            return panic("INFO memory should be decoded");
          }
          expect(value).toContain("maxmemory_policy:");
          return value.replace(
            /^maxmemory_policy:[^\r\n]+/mu,
            () => `maxmemory_policy:${reported}`,
          );
        });
      },
    );
    try {
      await client.connect();
      expect(await client.ping()).toBe("PONG");
      expect(statuses).toEqual(["allowed"]);
      reported = "allkeys-lru";
      client.emit("close");
      await expectStoreRefusal(client.eval("return 1", 0));
      expect(statuses).toEqual(["allowed", "refused"]);
      reported = "noeviction";
      client.emit("close");
      expect(await client.eval("return 1", 0)).toBe(1);
      expect(statuses).toEqual(["allowed", "refused", "allowed"]);
      expect(errors).toEqual([]);
    } finally {
      client.disconnect();
      send.mockRestore();
    }
  },
);
