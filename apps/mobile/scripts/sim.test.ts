import { describe, expect, test } from "bun:test";

import {
  chooseSimulator,
  developmentClientUrl,
  deviceArgument,
  serverUrl,
} from "./sim";
import type { SimulatorListing } from "./sim";

const RUNTIME = "com.apple.CoreSimulator.SimRuntime";

const device = (udid: string, name: string, state = "Shutdown") => ({
  udid,
  name,
  state,
});

describe("the simulator a run uses", () => {
  test("an iPhone on the newest iOS runtime, numerically compared", () => {
    const listing: SimulatorListing = {
      devices: {
        [`${RUNTIME}.iOS-9-3`]: [device("old", "iPhone 6")],
        [`${RUNTIME}.iOS-27-1`]: [
          device("ipad", "iPad Pro 13-inch"),
          device("new", "iPhone 18 Pro"),
        ],
        [`${RUNTIME}.iOS-27-0`]: [device("previous", "iPhone 18")],
        [`${RUNTIME}.watchOS-13-0`]: [device("watch", "Apple Watch")],
      },
    };
    expect(chooseSimulator(listing)).toEqual({
      udid: "new",
      name: "iPhone 18 Pro",
      booted: false,
    });
  });

  test("a booted iPhone wins, so a second simulator never starts", () => {
    const listing: SimulatorListing = {
      devices: {
        [`${RUNTIME}.iOS-27-1`]: [device("new", "iPhone 18 Pro")],
        [`${RUNTIME}.iOS-26-0`]: [device("running", "iPhone 17", "Booted")],
      },
    };
    expect(chooseSimulator(listing)).toEqual({
      udid: "running",
      name: "iPhone 17",
      booted: true,
    });
  });

  test("no iPhone simulator means none to run on", () => {
    expect(
      chooseSimulator({
        devices: {
          [`${RUNTIME}.iOS-27-1`]: [device("ipad", "iPad mini")],
          [`${RUNTIME}.tvOS-27-0`]: [device("tv", "Apple TV")],
        },
      }),
    ).toBeNull();
  });
});

describe("another simulator by name", () => {
  const listing: SimulatorListing = {
    devices: {
      [`${RUNTIME}.iOS-27-1`]: [
        device("phone", "iPhone 18 Pro"),
        device("ipad", "iPad Pro 11-inch (M5)"),
        device("duo", "iPhone Duo"),
      ],
    },
  };

  test("part of the name, in any case, picks it", () => {
    expect(chooseSimulator(listing, "ipad")?.udid).toBe("ipad");
    expect(chooseSimulator(listing, "Duo")?.udid).toBe("duo");
  });

  test("a name no simulator has means none", () => {
    expect(chooseSimulator(listing, "Vision")).toBeNull();
  });

  test("--device names it on the command line", () => {
    expect(deviceArgument(["--device", "iPad"])).toBe("iPad");
    expect(deviceArgument([])).toBeUndefined();
  });
});

test("the development client opens the Metro bundle on its port", () => {
  expect(developmentClientUrl(8197)).toBe(
    "exp+stella://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8197",
  );
});

describe("the server the app signs in to", () => {
  test("the running stack's API by default", () => {
    expect(serverUrl(undefined, "http://localhost:3399").unwrap()).toBe(
      "http://localhost:3399",
    );
  });

  test("a named server overrides it", () => {
    expect(
      serverUrl("https://stella.example", "http://localhost:3399").unwrap(),
    ).toBe("https://stella.example");
  });

  test("without a stack or a named server, the person is told to start one", () => {
    const missing = serverUrl("", null);
    expect(missing.isErr() ? missing.error : "a server").toContain(
      "bun run agent:up",
    );
  });
});
