import { expect, test } from "bun:test";

import {
  inspectComposeMounts,
  inspectDockerHelper,
  isDockerMountGuardInput,
} from "./check-docker-host-mounts";

const helperImport =
  'import { dockerVolumeName } from "./docker-volume-name";\n';

const accepts = [
  {
    id: "named-volume",
    inspect: inspectComposeMounts,
    source:
      "services:\n  app:\n    volumes:\n      - data:/data:ro\nvolumes:\n  data:\n",
  },
  {
    id: "tmpfs",
    inspect: inspectComposeMounts,
    source:
      "services:\n  app:\n    volumes:\n      - {type: tmpfs, target: /tmp}\n",
  },
  {
    id: "size-option",
    inspect: inspectDockerHelper,
    source: "docker volume create --opt size=10g data",
  },
  {
    id: "local-driver",
    inspect: inspectDockerHelper,
    source: "docker volume create --driver local data",
  },
  {
    id: "validated-name",
    inspect: inspectDockerHelper,
    source: `${helperImport}["docker", "run", "--mount", \`type=volume,source=\${dockerVolumeName(name)},target=/data\`]`,
  },
] as const;

const rejects = [
  {
    id: "mount-type",
    inspect: inspectDockerHelper,
    source:
      "docker --context local run --mount type=bind,source=./data,target=/data image",
  },
  {
    id: "short-mount",
    inspect: inspectDockerHelper,
    source: "docker run -v ./data:/data image",
  },
  {
    // A shell helper is no script: its quoted strings are still read.
    id: "shell-quoted-mount",
    inspect: inspectDockerHelper,
    source:
      'if [ -n "$data" ]; then\n  mount_args="-v $data:/data"\nfi\nrun_container "$mount_args"\n',
  },
  {
    id: "driver-option",
    inspect: inspectDockerHelper,
    source: "docker --context local volume create --opt type=none data",
  },
  {
    id: "driver-name",
    inspect: inspectDockerHelper,
    source: "docker volume create -dother data",
  },
  {
    id: "unresolved",
    inspect: inspectDockerHelper,
    source: '["docker", "volume", "create", ...options]',
  },
  {
    id: "api-mount-type",
    inspect: inspectDockerHelper,
    source: 'const options = {Mounts: [{Type: "bind", Source: "./data"}]};',
  },
  {
    id: "unresolved-shell-mount",
    inspect: inspectDockerHelper,
    source: "docker run --mount type=volume,source=$MOUNT,target=/data image",
  },
  {
    id: "unresolved-shell-argument",
    inspect: inspectDockerHelper,
    source: 'docker volume create "$OPTIONS" data',
  },
  {
    id: "unresolved-run-option",
    inspect: inspectDockerHelper,
    source: '["docker", "run", ...options, image]',
  },
  {
    id: "unknown-run-option",
    inspect: inspectDockerHelper,
    source: '["docker", "run", "--volumes-from=other", "image"]',
  },
  {
    id: "clustered-short-flag",
    inspect: inspectDockerHelper,
    source: "docker run -dv data:/data image",
  },
  {
    id: "inherited-volumes",
    inspect: inspectComposeMounts,
    source: "services:\n  app:\n    volumes_from: [other]\n",
  },
  {
    id: "api-inherited-volumes",
    inspect: inspectDockerHelper,
    source:
      'docker.createContainer({Image: "app", HostConfig: {VolumesFrom: ["other"]}});',
  },
  {
    id: "api-volume-options",
    inspect: inspectDockerHelper,
    source:
      'docker.createVolume({Name: "data", Driver: "local", DriverOpts: {type: "none"}});',
  },
] as const;

test("host mount guard accepts and rejects the documented cases", () => {
  for (const { id, inspect, source } of accepts) {
    expect({ id, failures: inspect(source) }).toEqual({ id, failures: [] });
  }
  for (const { id, inspect, source } of rejects) {
    expect({ id, rejected: inspect(source).length > 0 }).toEqual({
      id,
      rejected: true,
    });
  }
  for (const file of [
    "docker-compose.selfhost.yml",
    "apps/api/scripts/new-corpus-helper.ts",
  ]) {
    expect(isDockerMountGuardInput(file, "docker run")).toBe(true);
  }
});

test.each([
  'readonly ["ps", ...string[]]',
  'readonly ["compose", ...string[]] | readonly ["volume", "ls", ...string[]]',
])(
  "the mount guard proves each closed command tuple is non-mounting: %s",
  (type) => {
    const source = `type Commands = ${type}; type Alias = Commands; const command = (args: Alias) => ["docker", "--host", target.host, ...args];`;
    expect(inspectDockerHelper(source)).toEqual([]);
  },
);

test.each([
  "readonly string[]",
  "UnknownCommands",
  'readonly ["volume", ...string[]]',
  'readonly ["run", ...string[]]',
  'readonly ["volume", "create", ...string[]]',
  'readonly ["ps", ...string[]] | readonly ["container", "run", ...string[]]',
])("unsafe or unresolved parameter types remain refused: %s", (type) => {
  expect(
    inspectDockerHelper(
      `type Commands = ${type}; const command = (args: Commands) => ["docker", "--host", target.host, ...args];`,
    ).length,
  ).toBeGreaterThan(0);
});

test("an unresolved global flag cannot be made safe by a command tuple", () => {
  expect(
    inspectDockerHelper(
      'type Commands = readonly ["ps", ...string[]]; const command = (args: Commands) => ["docker", ...globals, ...args];',
    ).length,
  ).toBeGreaterThan(0);
});

test.each([
  'const wrapper = (args: Commands) => { { const args = untrusted; return ["docker", ...args]; } };',
  'const wrapper = (args: Commands) => { return values.map((args) => ["docker", ...args]); };',
  'const wrapper = (args: Commands) => { try {} catch (args) { return ["docker", ...args]; } };',
  'const wrapper = (args: Commands) => { for (const args of values) { return ["docker", ...args]; } };',
  'const wrapper = () => { type Commands = readonly ["run", ...string[]]; return (args: Commands) => ["docker", ...args]; };',
  'const wrapper = <Commands>(args: Commands) => ["docker", ...args];',
  'const wrapper = () => { class Commands extends Array<string> {} return (args: Commands) => ["docker", ...args]; };',
  'const wrapper = () => { enum Commands { unsafe } return (args: Commands) => ["docker", ...args]; };',
])(
  "nearer lexical bindings cannot borrow a safe outer command type: %s",
  (body) => {
    expect(
      inspectDockerHelper(
        `type Commands = readonly ["ps", ...string[]]; ${body}`,
      ).length,
    ).toBeGreaterThan(0);
  },
);

test("a constant parameter alias and a typed nested callback retain their actual command domain", () => {
  expect(
    inspectDockerHelper(
      'type Commands = readonly ["ps", ...string[]]; const wrapper = (args: Commands) => { const alias = args; return values.map((other: Commands) => [["docker", ...alias], ["docker", ...other]]); };',
    ),
  ).toEqual([]);
});
