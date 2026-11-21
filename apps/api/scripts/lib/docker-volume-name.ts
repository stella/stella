import { panic } from "better-result";
import * as v from "valibot";

const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const DOCKER_IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]*$/u;

const dockerVolumeNameSchema = v.pipe(
  v.string(),
  v.regex(DOCKER_NAME),
  v.brand("DockerVolumeName"),
);
const dockerContainerNameSchema = v.pipe(
  v.string(),
  v.regex(DOCKER_NAME),
  v.brand("DockerContainerName"),
);
const dockerImageRefSchema = v.pipe(
  v.string(),
  v.regex(DOCKER_IMAGE_REF),
  v.brand("DockerImageRef"),
);

export type DockerVolumeName = v.InferOutput<typeof dockerVolumeNameSchema>;
export type DockerContainerName = v.InferOutput<
  typeof dockerContainerNameSchema
>;
export type DockerImageRef = v.InferOutput<typeof dockerImageRefSchema>;

// Docker's volume-name charset excludes the comma and equals sign that
// delimit --mount options. Every caller passes a name built from internal
// constants, so a violation is programmer misuse: panic rather than return a
// Result. scripts/check-docker-host-mounts.ts accepts interpolation into a
// mount string only through these functions.
export const dockerVolumeName = (value: string): DockerVolumeName => {
  const parsed = v.safeParse(dockerVolumeNameSchema, value);
  return parsed.success
    ? parsed.output
    : panic(`Invalid Docker volume name: ${JSON.stringify(value)}`);
};

// Container names share the volume-name charset. Same contract, and the only
// dynamic value the guard lets through in a docker run option position.
export const dockerContainerName = (value: string): DockerContainerName => {
  const parsed = v.safeParse(dockerContainerNameSchema, value);
  return parsed.success
    ? parsed.output
    : panic(`Invalid Docker container name: ${JSON.stringify(value)}`);
};

// An image reference or ID cannot start with "-", so a validated value never
// reads as a docker run option.
export const dockerImageRef = (value: string): DockerImageRef => {
  const parsed = v.safeParse(dockerImageRefSchema, value);
  return parsed.success
    ? parsed.output
    : panic(`Invalid Docker image reference: ${JSON.stringify(value)}`);
};
