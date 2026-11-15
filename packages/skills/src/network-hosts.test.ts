import { describe, expect, test } from "bun:test";

import { validateSkillPackage } from "./format";
import {
  readSkillNetworkHosts,
  requestedNetworkHost,
  SKILL_NETWORK_HOSTS_MAX,
} from "./network-hosts";

const skillWith = (metadataLine: string) => ({
  files: [
    {
      path: "SKILL.md",
      content: `---\nname: weather-facts\ndescription: Reads public weather data.\nmetadata:\n  ${metadataLine}\n---\n\nRun the scripts.\n`,
    },
  ],
  tools: { type: "deferred" } as const,
});

describe("declared network hosts", () => {
  test("reads exact host names once each, in declared order", () => {
    expect(
      readSkillNetworkHosts({
        "stella-network-hosts":
          " www.ogimet.com  aviationweather.gov\nwww.ogimet.com ",
      }),
    ).toEqual(["www.ogimet.com", "aviationweather.gov"]);
  });

  test("a skill without the key declares no host", () => {
    expect(readSkillNetworkHosts({})).toEqual([]);
    expect(readSkillNetworkHosts(undefined)).toEqual([]);
  });

  test.each([
    "https://www.ogimet.com",
    "*.ogimet.com",
    "www.ogimet.com:443",
    "Www.Ogimet.com",
    "192.168.1.10",
    "localhost",
    "ogimet..com",
    "-ogimet.com",
  ])("one malformed entry (%s) grants nothing", (entry) => {
    expect(
      readSkillNetworkHosts({
        "stella-network-hosts": `aviationweather.gov ${entry}`,
      }),
    ).toBeNull();
  });

  test("a package with a malformed declaration is refused", () => {
    const result = validateSkillPackage(
      skillWith('stella-network-hosts: "https://www.ogimet.com"'),
    );
    expect(result.isErr() && result.error).toContainEqual({
      type: "metadata_value_invalid",
      key: "stella-network-hosts",
    });
  });

  test("a package declaring more hosts than allowed is refused", () => {
    const hosts = Array.from(
      { length: SKILL_NETWORK_HOSTS_MAX + 1 },
      (_, index) => `host${index}.example.org`,
    ).join(" ");
    const result = validateSkillPackage(
      skillWith(`stella-network-hosts: "${hosts}"`),
    );
    expect(result.isErr() && result.error).toContainEqual({
      type: "limit_exceeded",
      field: "metadata.stella-network-hosts",
      limit: SKILL_NETWORK_HOSTS_MAX,
    });
  });

  test("a package with well-formed hosts is accepted", () => {
    const result = validateSkillPackage(
      skillWith('stella-network-hosts: "www.ogimet.com aviationweather.gov"'),
    );
    expect(result.isOk()).toBe(true);
  });
});

describe("a requested host compared with declarations", () => {
  test("drops case, a port and a trailing dot", () => {
    expect(requestedNetworkHost("WWW.Ogimet.com:443")).toBe("www.ogimet.com");
    expect(requestedNetworkHost("aviationweather.gov.")).toBe(
      "aviationweather.gov",
    );
  });

  test("anything that is not a host name matches nothing", () => {
    expect(requestedNetworkHost("10.0.0.1")).toBeNull();
    expect(requestedNetworkHost("")).toBeNull();
    expect(requestedNetworkHost("evil.com/www.ogimet.com")).toBeNull();
  });
});
