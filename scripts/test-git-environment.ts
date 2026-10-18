import { panic } from "better-result";

const rawConfigCount = process.env.GIT_CONFIG_COUNT ?? "0";

if (!/^\d+$/u.test(rawConfigCount)) {
  panic(`Invalid GIT_CONFIG_COUNT: ${rawConfigCount}`);
}

let configCount = Number(rawConfigCount);

const appendGitConfig = (key: string, value: string) => {
  process.env[`GIT_CONFIG_KEY_${configCount}`] = key;
  process.env[`GIT_CONFIG_VALUE_${configCount}`] = value;
  configCount += 1;
};

appendGitConfig("maintenance.auto", "false");
appendGitConfig("gc.auto", "0");
appendGitConfig("gc.autoDetach", "false");
process.env.GIT_CONFIG_COUNT = String(configCount);
