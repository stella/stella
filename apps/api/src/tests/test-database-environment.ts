import packageJson from "../../package.json" with { type: "json" };

const POSTGRES_TEST_RUNNER = packageJson.ciGateTestRunners["test:postgres"];
export const POSTGRES_TEST_MARKER = POSTGRES_TEST_RUNNER.gate;

const ROOT_POOL_SENTINEL = Symbol.for("stella.tests.rootPoolSentinel");

/**
 * Where hermetic tests point the shared database pools. Hermetic suites run
 * against the in-process test database; a connection to the shared pools is
 * a side path that escaped it. The sentinel counts each connection and
 * answers it with a Postgres error naming itself, so the query fails at once
 * (a bare close would make the driver retry until its connect timeout).
 */
type RootPoolSentinel = {
  connections: number;
  /** Held here, on the process-wide sentinel, so the listener lives as long
   *  as its URL: a collected listener would let queries fail uncounted. */
  listener: Bun.TCPSocketListener<undefined> | null;
  url: string;
};

export const ROOT_POOL_SENTINEL_MESSAGE =
  "hermetic test: the shared database pools are not configured; use the test database";

/** A Postgres `ErrorResponse` message: FATAL, SQLSTATE 08004. */
const sentinelErrorResponse = (): Buffer => {
  const body = Buffer.from(
    `SFATAL\0VFATAL\0C08004\0M${ROOT_POOL_SENTINEL_MESSAGE}\0\0`,
    "utf-8",
  );
  const header = Buffer.alloc(5);
  header.write("E", 0);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};

const isRootPoolSentinel = (value: unknown): value is RootPoolSentinel =>
  typeof value === "object" &&
  value !== null &&
  "connections" in value &&
  typeof value.connections === "number" &&
  "url" in value &&
  typeof value.url === "string";

const startRootPoolSentinel = (): RootPoolSentinel => {
  const sentinel: RootPoolSentinel = {
    connections: 0,
    listener: null,
    url: "",
  };
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data: () => undefined,
      open: (socket) => {
        sentinel.connections += 1;
        socket.end(sentinelErrorResponse());
      },
    },
  });
  // The sentinel never keeps a test process alive.
  listener.unref();
  sentinel.listener = listener;
  sentinel.url = `postgres://postgres:postgres@127.0.0.1:${String(listener.port)}/stella`;
  return sentinel;
};

/** This process's sentinel, started on first use. */
export const rootPoolSentinelUrl = (): string => {
  const existing: unknown = Reflect.get(globalThis, ROOT_POOL_SENTINEL);
  if (isRootPoolSentinel(existing)) {
    return existing.url;
  }
  const started = startRootPoolSentinel();
  Reflect.set(globalThis, ROOT_POOL_SENTINEL, started);
  return started.url;
};

/**
 * Connections the shared pools opened so far in this process, or `null`
 * when the suite runs against a real Postgres (no sentinel).
 */
export const rootPoolConnectionCount = (): number | null => {
  const existing: unknown = Reflect.get(globalThis, ROOT_POOL_SENTINEL);
  return isRootPoolSentinel(existing) ? existing.connections : null;
};

export const configureTestDatabaseEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
  sentinelUrl: () => string = rootPoolSentinelUrl,
) => {
  if (
    environment[POSTGRES_TEST_MARKER] === POSTGRES_TEST_RUNNER.gateValue ||
    environment[packageJson.ciGateTestRunners["test:perf"].gate] ===
      packageJson.ciGateTestRunners["test:perf"].gateValue
  ) {
    return;
  }
  environment["DATABASE_URL"] = sentinelUrl();
};
