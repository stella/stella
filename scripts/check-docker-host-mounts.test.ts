import { expect, test } from "bun:test";

import {
  inspectComposeMounts,
  inspectDockerHelper,
  isDockerMountGuardInput,
} from "./check-docker-host-mounts";

test("compose rejects host and unresolved sources across mount syntaxes", () => {
  for (const mount of [
    "./data:/data",
    "../data:/data",
    "/host:/data",
    "~/data:/data",
    `\${DATA}:/data`,
    "C:\\data:/data",
    "{type: bind, source: ./data, target: /data}",
    "{source: ./data, target: /data}",
    `{type: volume, source: '\${DATA}', target: /data}`,
  ]) {
    expect(
      inspectComposeMounts(
        `services:\n  app:\n    volumes:\n      - ${mount}\n`,
      ),
    ).not.toEqual([]);
  }
  expect(
    inspectComposeMounts(
      "volumes:\n  data:\n    driver_opts: {type: none, o: bind, device: /host}\n",
    ),
  ).not.toEqual([]);
  expect(
    inspectComposeMounts("configs:\n  config: {file: ./config}\n"),
  ).not.toEqual([]);
});

test("compose permits named volumes and anonymous container volumes", () => {
  expect(
    inspectComposeMounts(
      "services:\n  app:\n    volumes:\n      - data:/data:ro\n      - /cache\n      - {type: volume, source: data, target: /data}\n      - {type: tmpfs, target: /tmp}\nvolumes:\n  data:\n",
    ),
  ).toEqual([]);
});

test("YAML aliases cannot hide bind mounts", () => {
  expect(
    inspectComposeMounts(
      "x-mount: &mount {type: bind, source: /host, target: /data}\nservices:\n  app:\n    volumes: [*mount]\n",
    ),
  ).not.toEqual([]);
});

test("Docker helpers reject CLI and API bind mechanisms, including interpolated arguments", () => {
  for (const source of [
    "docker run -v /host:/data image",
    "docker run -v/host:/data image",
    "docker run --mount=type=bind,source=/host,target=/data image",
    "docker run --mount 'type=bind,source=/host,target=/data' image",
    `["docker", "run", \`-v\${host}:/data\`]`,
    'const config = {["Binds"]: hostMounts};',
    "const config = {Binds};",
    "options.Binds = hostMounts;",
    "const options = {Mounts: mounts};",
    "const options = {Mounts: [{Type: mountType, Source: host}]};",
    'const options = {Mounts: [{Type: "volume", ...mount}]};',
    'const options = {Mounts: [{Type: "volume", Type: mountType}]};',
    'client.containers.run("image", host_config={"Binds": ["/host:/data"]})',
    'client.containers.run("image", mounts=[{"Type": "bind", "Source": "/host"}])',
    "docker run --mount type=bind,source=/host,target=/data image",
    `["docker", "run", "-v", \`\${dir}:/data\`]`,
    '["docker", "run", "--volume=/host:/data"]',
    `["docker", "run", "--mount", \`type=bind,source=\${dir},target=/data\`]`,
    '["docker", "run", "--mount", mountOptions]',
    `const options = {HostConfig: {Binds: [\`\${dir}:/data\`]}};`,
    'const options = {Mounts: [{Type: "bind", Source: dir, Target: "/data"}]};',
  ]) {
    expect(inspectDockerHelper(source)).not.toEqual([]);
  }
  expect(
    inspectDockerHelper(
      `["docker", "run", "--mount", \`type=volume,source=\${name},target=/data\`]`,
    ),
  ).toEqual([]);
  expect(
    inspectDockerHelper(
      'const options = {Mounts: [{Type: "volume", Source: name, Target: "/data"}, {Type: "tmpfs", Target: "/tmp"}]};',
    ),
  ).toEqual([]);
});

test("Docker helpers reject mount types hidden after earlier options", () => {
  for (const source of [
    "docker run --mount type=volume,source=data,target=/data,type=bind image",
    "docker run --mount source=/host,target=/data,type=bind image",
    '["docker", "run", "--mount", "type=tmpfs,target=/data,type=bind"]',
    '["docker", "run", "--mount=source=/host,target=/data,type=bind"]',
  ]) {
    expect(inspectDockerHelper(source)).not.toEqual([]);
  }
});

test("Docker helpers reject host-backed named volume driver options", () => {
  for (const source of [
    'const options = {Mounts: [{Type: "volume", VolumeOptions: {DriverConfig: {Name: "local", Options: {type: "none"}}}}]};',
    'const options = {Mounts: [{Type: "volume", VolumeOptions: {DriverConfig: {Name: "local", Options: {o: "bind,rw"}}}}]};',
    'const options = {Mounts: [{Type: "volume", VolumeOptions: {DriverConfig: {Name: "local", Options: {device: "/host"}}}}]};',
    "docker volume create --opt type=none data",
    "docker volume create --opt=o=bind,rw data",
    "docker volume create -o device=/host data",
  ]) {
    expect(inspectDockerHelper(source)).not.toEqual([]);
  }
});

test("Docker helpers permit plain named volumes, tmpfs, and safe local driver configuration", () => {
  for (const source of [
    'const options = {Mounts: [{Type: "volume", Source: "data", Target: "/data"}]};',
    'const options = {Mounts: [{Type: "tmpfs", Target: "/tmp"}]};',
    'const options = {Mounts: [{Type: "volume", VolumeOptions: {DriverConfig: {Name: "local", Options: {size: "10g"}}}}]};',
    "docker volume create --opt size=10g data",
  ]) {
    expect(inspectDockerHelper(source)).toEqual([]);
  }
});

test("compose permits safe driver options and rejects host-backed local volumes", () => {
  expect(
    inspectComposeMounts(
      "volumes:\n  data:\n    driver: local\n    driver_opts: {size: 10g}\n",
    ),
  ).toEqual([]);
  for (const options of ["type: none", "o: bind,rw", "device: /host"]) {
    expect(
      inspectComposeMounts(
        `volumes:\n  data:\n    driver: local\n    driver_opts: {${options}}\n`,
      ),
    ).not.toEqual([]);
  }
});

test("Docker mount types cannot be overridden by computed properties", () => {
  for (const key of ['["Type"]', "[`Type`]", "[key]"]) {
    expect(
      inspectDockerHelper(
        `const options = {Mounts: [{Type: "volume", ${key}: mountType, Source: host, Target: "/data"}]};`,
      ),
    ).not.toEqual([]);
  }
  for (const key of ['["Type"]', "[`Type`]"]) {
    expect(
      inspectDockerHelper(
        `const options = {["Mounts"]: [{${key}: "volume", Source: name, Target: "/data"}]};`,
      ),
    ).toEqual([]);
  }
});

test("guard discovers compose variants and newly added corpus Docker helpers", () => {
  for (const file of [
    "docker-compose.yml",
    "docker-compose.selfhost.yml",
    "deploy/compose.production.yaml",
    "apps/api/scripts/new-corpus-helper.ts",
    "scripts/run-new-suite.ts",
    "apps/api/scripts/container-helper.ts",
  ]) {
    expect(isDockerMountGuardInput(file, "docker run")).toBe(true);
  }
  expect(
    isDockerMountGuardInput(
      "apps/api/scripts/new-corpus-helper.test.ts",
      "docker run",
    ),
  ).toBe(false);
});

test("recursive YAML aliases terminate safely", () => {
  expect(
    inspectComposeMounts(
      "x-loop: &loop [*loop]\nservices:\n  app:\n    volumes: [data:/data]\n",
    ),
  ).toEqual([]);
});
