import { expect, test } from "bun:test";

import {
  inspectComposeMounts,
  inspectDockerHelper,
  isDockerMountGuardInput,
} from "./check-docker-host-mounts";

const composeWith = (volumes: string) =>
  `services:\n  app:\n    volumes:\n      - ${volumes}\n`;

const bindMount = "type=bind,source=/host,target=/data";
const hostVolume =
  "type=volume,source=data,target=/data,volume-opt=device=/host";

const accepts = [
  {
    id: "compose-named-volume",
    inspect: inspectComposeMounts,
    source: `${composeWith("data:/data:ro")}volumes:\n  data:\n`,
  },
  {
    id: "compose-tmpfs",
    inspect: inspectComposeMounts,
    source: composeWith("{type: tmpfs, target: /tmp}"),
  },
  {
    id: "compose-driver-size",
    inspect: inspectComposeMounts,
    source: "volumes:\n  data:\n    driver_opts: {size: 10g}\n",
  },
  {
    id: "api-volume-and-tmpfs",
    inspect: inspectDockerHelper,
    source:
      'const options = {Mounts: [{Type: "volume", Source: "data"}, {Type: "tmpfs", Target: "/tmp"}]};',
  },
  {
    id: "cli-volume-mount",
    inspect: inspectDockerHelper,
    source:
      "docker run --mount type=volume,source=data,target=/data,volume-opt=size=10g image",
  },
  {
    id: "cli-plain-volume-create",
    inspect: inspectDockerHelper,
    source: "docker volume create data",
  },
  {
    id: "cli-volume-create-size",
    inspect: inspectDockerHelper,
    source: "docker volume create --opt size=10g data",
  },
  {
    id: "cli-volume-create-attached-size",
    inspect: inspectDockerHelper,
    source: "docker volume create -osize=10g data",
  },
  {
    id: "argv-volume-create-attached-size",
    inspect: inspectDockerHelper,
    source: '["docker", "volume", "create", "-osize=10g", "data"]',
  },
  {
    id: "compose-local-driver",
    inspect: inspectComposeMounts,
    source: "volumes:\n  data:\n    driver: local\n",
  },
  {
    id: "cli-local-driver",
    inspect: inspectDockerHelper,
    source: "docker volume create --driver local data",
  },
  {
    id: "argv-local-driver",
    inspect: inspectDockerHelper,
    source: '["docker", "volume", "create", "-d", "local", "data"]',
  },
  {
    id: "cli-mount-local-driver",
    inspect: inspectDockerHelper,
    source:
      "docker run --mount type=volume,source=data,target=/data,volume-driver=local image",
  },
  {
    id: "cli-volume-driver-local",
    inspect: inspectDockerHelper,
    source:
      "docker run --mount type=volume,source=data,target=/data --volume-driver local image",
  },
  {
    id: "argv-volume-create-dynamic-name",
    inspect: inspectDockerHelper,
    source: '["docker", "volume", "create", "--opt", "size=10g", name]',
  },
  {
    id: "argv-mount-dynamic-source",
    inspect: inspectDockerHelper,
    source: `["docker", "run", "--mount", \`type=volume,source=\${name},target=/data\`]`,
  },
] as const;

const rejects = [
  {
    id: "host-backed-1",
    inspect: inspectComposeMounts,
    source: composeWith("./data:/data"),
  },
  {
    id: "host-backed-2",
    inspect: inspectComposeMounts,
    source: "volumes:\n  data:\n    driver_opts: {type: none, o: bind}\n",
  },
  {
    id: "host-backed-3",
    inspect: inspectComposeMounts,
    source: "configs:\n  config: {file: ./config}\n",
  },
  {
    id: "host-backed-4",
    inspect: inspectDockerHelper,
    source: `docker run --mount ${bindMount} image`,
  },
  {
    id: "host-backed-5",
    inspect: inspectDockerHelper,
    source: `["docker", "run", "--mount", "${bindMount}"]`,
  },
  {
    id: "host-backed-6",
    inspect: inspectDockerHelper,
    source: `docker run --mount ${hostVolume} image`,
  },
  {
    id: "host-backed-7",
    inspect: inspectDockerHelper,
    source: "docker run -v /host:/data image",
  },
  {
    id: "host-backed-8",
    inspect: inspectDockerHelper,
    source: 'const options = {Mounts: [{Type: "bind", Source: "/host"}]};',
  },
  {
    id: "host-backed-9",
    inspect: inspectDockerHelper,
    source:
      'const options = {Mounts: [{Type: "volume", VolumeOptions: {DriverConfig: {Name: "local", Options: {device: "/host"}}}}]};',
  },
  {
    id: "host-backed-10",
    inspect: inspectDockerHelper,
    source: "docker volume create --opt type=none data",
  },
  {
    id: "host-backed-11",
    inspect: inspectDockerHelper,
    source: '["docker", "volume", "create", "--opt", "device=/host", "data"]',
  },
  {
    id: "host-backed-12",
    inspect: inspectDockerHelper,
    source: '["docker", "volume", "create", option, "data"]',
  },
  {
    id: "host-backed-13",
    inspect: inspectDockerHelper,
    source: 'const options = {Mounts: [{Type: mountType, Source: "data"}]};',
  },
  {
    id: "host-backed-14",
    inspect: inspectDockerHelper,
    source: '["docker", "run", "--mount", mountOptions]',
  },
  {
    id: "host-backed-15",
    inspect: inspectDockerHelper,
    source: "docker volume create -otype=none -odevice=/host -oo=bind data",
  },
  {
    id: "host-backed-16",
    inspect: inspectDockerHelper,
    source:
      '["docker", "volume", "create", "-otype=none", "-odevice=/host", "data"]',
  },
  {
    id: "host-backed-17",
    inspect: inspectDockerHelper,
    source: '["docker", "volume", "create", "--opt", "uid=0", "data"]',
  },
  {
    id: "host-backed-18",
    inspect: inspectComposeMounts,
    source: "volumes:\n  data:\n    driver: other\n",
  },
  {
    id: "host-backed-19",
    inspect: inspectDockerHelper,
    source: "docker volume create -dother data",
  },
  {
    id: "host-backed-20",
    inspect: inspectDockerHelper,
    source: '["docker", "volume", "create", "--driver", driverName, "data"]',
  },
  {
    id: "host-backed-21",
    inspect: inspectDockerHelper,
    source:
      'const options = {Mounts: [{Type: "volume", VolumeOptions: {DriverConfig: {Name: "other"}}}]};',
  },
  {
    id: "host-backed-22",
    inspect: inspectDockerHelper,
    source:
      "docker run --mount type=volume,source=data,target=/data,volume-driver=other image",
  },
  {
    id: "host-backed-23",
    inspect: inspectDockerHelper,
    source:
      '["docker", "run", "--mount", "type=volume,source=data,target=/data,volume-driver=other"]',
  },
  {
    id: "host-backed-24",
    inspect: inspectDockerHelper,
    source:
      "docker run --volume-driver other --mount type=volume,source=data,target=/data image",
  },
  {
    id: "host-backed-25",
    inspect: inspectDockerHelper,
    source:
      '["docker", "run", "--volume-driver=other", "--mount", "type=volume,target=/data"]',
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
