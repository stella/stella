// The app on an iOS simulator against this checkout's local stack, in one
// command, for a person trying it out:
//
//   bun run agent:up     start the seeded stack (once)
//   bun run mobile:sim   then this, from the repository root
//
// It reuses a booted iPhone simulator, or boots the newest iPhone on the
// newest iOS runtime; keeps its development client in step with the checkout
// (`native-client.ts ensure`, which builds only when the native fingerprint
// moved); starts Metro on a free port with the stack's API as the prefilled
// server; and opens the app. Ctrl-C stops Metro, and the simulator too when
// this run booted it, so nothing keeps running once you are done.
//
// `STELLA_SERVER_URL` names another server than the stack's API.

import { Result } from "better-result";
import path from "node:path";
import * as v from "valibot";

import { childExitStatus } from "@stll/scripts/src/child-exit-status";
import { readDevRuntime } from "@stll/scripts/src/dev-runtime";

const APP_ROOT = path.resolve(import.meta.dir, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "../..");
const DEVELOPMENT_IDENTIFIER = "app.stll.mobile.dev";
const METRO_READY_TIMEOUT_MS = 180_000;

const simulatorListingSchema = v.object({
  devices: v.record(
    v.string(),
    v.array(
      v.object({
        udid: v.string(),
        name: v.string(),
        state: v.string(),
      }),
    ),
  ),
});

export type SimulatorListing = v.InferOutput<typeof simulatorListingSchema>;

export type SimulatorChoice = {
  readonly udid: string;
  readonly name: string;
  readonly booted: boolean;
};

/** `com.apple.CoreSimulator.SimRuntime.iOS-27-1` as [27, 1]; null for other platforms. */
const iosRuntimeVersion = (runtime: string): readonly number[] | null => {
  const version = /\.iOS-(\d+(?:-\d+)*)$/u.exec(runtime)?.[1];
  return version === undefined ? null : version.split("-").map(Number);
};

const newerFirst = (a: readonly number[], b: readonly number[]) => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

/**
 * The simulator to run on: an iPhone that is already booted, so a second
 * device never starts beside it, otherwise an iPhone on the newest iOS
 * runtime. Null when no iPhone simulator is installed.
 */
export const chooseSimulator = (
  listing: SimulatorListing,
): SimulatorChoice | null => {
  const runtimes = Object.entries(listing.devices)
    .flatMap(([runtime, devices]) => {
      const version = iosRuntimeVersion(runtime);
      return version === null ? [] : [{ version, devices }];
    })
    .toSorted((a, b) => newerFirst(a.version, b.version));
  const iPhones = runtimes.flatMap(({ devices }) =>
    devices.filter((device) => device.name.startsWith("iPhone")),
  );
  const chosen =
    iPhones.find((device) => device.state === "Booted") ?? iPhones[0];
  return chosen === undefined
    ? null
    : {
        udid: chosen.udid,
        name: chosen.name,
        booted: chosen.state === "Booted",
      };
};

/** The link that opens a Metro bundle in the development client. */
export const developmentClientUrl = (metroPort: number) =>
  `exp+stella://expo-development-client/?url=${encodeURIComponent(`http://localhost:${String(metroPort)}`)}`;

/** The server the sign-in screen is prefilled with, or why there is none. */
export const serverUrl = (
  override: string | undefined,
  stackApiUrl: string | null,
): Result<string, string> => {
  if (override !== undefined && override !== "") {
    return Result.ok(override);
  }
  return stackApiUrl === null
    ? Result.err(
        "No local stack is running for this checkout. Start it with `bun run agent:up`, or name a server in STELLA_SERVER_URL.",
      )
    : Result.ok(stackApiUrl);
};

const run = async (command: readonly string[]) => {
  const handle = Bun.spawn([...command], {
    cwd: APP_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(handle.stdout).text(),
    new Response(handle.stderr).text(),
    handle.exited,
  ]);
  return { exitCode: childExitStatus(handle), stdout, stderr: stderr.trim() };
};

const runVisibly = async (command: readonly string[]) => {
  const handle = Bun.spawn([...command], {
    cwd: APP_ROOT,
    stderr: "inherit",
    stdout: "inherit",
  });
  await handle.exited;
  return childExitStatus(handle);
};

/** A port nothing listens on now, so this Metro never meets another checkout's. */
const freePort = () => {
  const probe = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: () => undefined },
  });
  const { port } = probe;
  probe.stop(true);
  return port;
};

/** Asks Metro once a second whether it serves, until it does or the deadline passes. */
const metroReady = async (
  port: number,
  deadline = Date.now() + METRO_READY_TIMEOUT_MS,
): Promise<boolean> => {
  const status = await Result.tryPromise(async () => {
    const response = await fetch(`http://localhost:${String(port)}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    return await response.text();
  });
  if (Result.isOk(status) && status.value.includes("packager-status:running")) {
    return true;
  }
  if (Date.now() >= deadline) {
    return false;
  }
  await Bun.sleep(1000);
  return await metroReady(port, deadline);
};

const fail = (message: string) => {
  process.stderr.write(`${message}\n`);
  return 1;
};

const main = async (): Promise<number> => {
  if (process.platform !== "darwin") {
    return fail("The iOS simulator runs only on macOS.");
  }
  const server = serverUrl(
    process.env["STELLA_SERVER_URL"],
    readDevRuntime(REPO_ROOT)?.apiUrl ?? null,
  );
  if (Result.isError(server)) {
    return fail(server.error);
  }

  const listing = await run([
    "xcrun",
    "simctl",
    "list",
    "devices",
    "available",
    "--json",
  ]);
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), simulatorListingSchema),
    listing.stdout,
  );
  if (listing.exitCode !== 0 || !parsed.success) {
    return fail(
      `Could not list simulators; is Xcode installed? ${listing.stderr}`,
    );
  }
  const simulator = chooseSimulator(parsed.output);
  if (simulator === null) {
    return fail(
      "No iPhone simulator is installed. Add an iOS runtime in Xcode (Settings > Components).",
    );
  }

  const bootedHere = !simulator.booted;
  const cleanUp = async () => {
    if (bootedHere) {
      process.stdout.write(`Stopping ${simulator.name}.\n`);
      await run(["xcrun", "simctl", "shutdown", simulator.udid]);
    }
  };
  if (bootedHere) {
    process.stdout.write(`Booting ${simulator.name}.\n`);
    const boot = await run(["xcrun", "simctl", "boot", simulator.udid]);
    if (boot.exitCode !== 0) {
      return fail(`Could not boot ${simulator.name}: ${boot.stderr}`);
    }
  }
  await run([
    "open",
    "-a",
    "Simulator",
    "--args",
    "-CurrentDeviceUDID",
    simulator.udid,
  ]);

  const ensured = await runVisibly([
    "bun",
    "scripts/native-client.ts",
    "ensure",
    "ios",
    simulator.udid,
  ]);
  if (ensured !== 0) {
    await cleanUp();
    return fail("The development client could not be built or installed.");
  }

  const port = freePort();
  process.stdout.write(
    `Starting Metro on port ${String(port)}; the app signs in to ${server.value}.\n`,
  );
  const metro = Bun.spawn(
    ["bunx", "expo", "start", "--dev-client", "--port", String(port)],
    {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        APP_VARIANT: "development",
        // Keeps Expo from prompting; Metro's log still streams here.
        CI: "1",
        EXPO_PUBLIC_STELLA_SERVER_URL: server.value,
      },
      stderr: "inherit",
      stdout: "inherit",
    },
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    metro.kill("SIGINT");
    await metro.exited;
    await cleanUp();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void stop().then(() => process.exit(130));
    });
  }

  if (!(await metroReady(port))) {
    await stop();
    return fail("Metro did not start; its output above says why.");
  }
  // A build launches the client at Expo's default bundler address, whose
  // failure page would stay over the app; it starts afresh on this Metro.
  await run([
    "xcrun",
    "simctl",
    "terminate",
    simulator.udid,
    DEVELOPMENT_IDENTIFIER,
  ]);
  const opened = await run([
    "xcrun",
    "simctl",
    "openurl",
    simulator.udid,
    developmentClientUrl(port),
  ]);
  if (opened.exitCode === 0) {
    process.stdout.write(
      "The app is open on the simulator. Sign in as test@stella.dev; the sign-in page fills in the emailed code. Press Ctrl-C to stop.\n",
    );
  } else {
    // Metro keeps serving, so the app can still be opened by hand.
    process.stderr.write(
      `Could not open ${DEVELOPMENT_IDENTIFIER}: ${opened.stderr}\nOpen stella Dev on the simulator and enter http://localhost:${String(port)}, or press Ctrl-C to stop.\n`,
    );
  }

  await metro.exited;
  await stop();
  return childExitStatus(metro);
};

if (import.meta.main) {
  process.exit(await main());
}
