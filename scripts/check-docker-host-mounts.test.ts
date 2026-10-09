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
    source: "docker run --mount type=bind,source=./data,target=/data image",
  },
  {
    id: "short-mount",
    inspect: inspectDockerHelper,
    source: "docker run -v ./data:/data image",
  },
  {
    id: "driver-option",
    inspect: inspectDockerHelper,
    source: "docker volume create --opt type=none data",
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
