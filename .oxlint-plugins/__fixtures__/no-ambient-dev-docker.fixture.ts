import {
  dockerCommand,
  type DockerTarget,
} from "../../packages/scripts/src/dev-docker";

declare const target: DockerTarget;

// oxlint-disable-next-line no-ambient-dev-docker/no-ambient-dev-docker -- fixture proves ambient executable references must use the pinned owner
export const ambientExecutable = "docker";

// expect-clean: no-ambient-dev-docker/no-ambient-dev-docker
export const pinnedInventory = dockerCommand(target, ["ps"]);
