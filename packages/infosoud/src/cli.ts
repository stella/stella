#!/usr/bin/env bun
import { resolveCliLookupInput } from "./cli-input.js";
import { InfoSoudClient } from "./client.js";
import { isCourtCode, resolveCourtCodeAlias } from "./courts.js";
import {
  formatCaseSummary,
  formatHearingsSummary,
  serializeCaseEventsCsv,
  serializeCourtMapCsv,
  serializeHearingsCsv,
} from "./format.js";

const HELP_TEXT = `InfoSoud - Czech court case lookup (infosoud.gov.cz)

Usage:
  infosoud [--hearings] [--json | --csv] <spis_zn> [court]
  infosoud --courts [--json | --csv]

Examples:
  infosoud "1 T 64/2024" OSSCEDC
  infosoud "1T64_2024 OSSCEDC"
  infosoud "4 T 21/2025 melnik"
  infosoud --hearings "1 T 64/2024" OSSCEDC
  infosoud --courts
`;

type CliFlags = {
  readonly courtList: boolean;
  readonly csv: boolean;
  readonly help: boolean;
  readonly hearings: boolean;
  readonly json: boolean;
  readonly positionals: string[];
};

const printStdout = (value: string): void => {
  // eslint-disable-next-line no-console -- CLI output
  console.log(value);
};

const printStderr = (value: string): void => {
  // eslint-disable-next-line no-console -- CLI error output
  console.error(value);
};

const parseArgs = (args: readonly string[]): CliFlags => {
  const positionals: string[] = [];
  let courtList = false;
  let csv = false;
  let hearings = false;
  let help = false;
  let json = false;

  for (const arg of args) {
    if (arg === "--courts") {
      courtList = true;
      continue;
    }

    if (arg === "--csv") {
      csv = true;
      continue;
    }

    if (arg === "--hearings") {
      hearings = true;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positionals.push(arg);
  }

  return { courtList, csv, help, hearings, json, positionals };
};

const resolveCourtReference = async (
  client: InfoSoudClient,
  value: string,
): Promise<string> => {
  const trimmed = value.trim();
  if (isCourtCode(trimmed)) {
    return resolveCourtCodeAlias(trimmed);
  }

  const resolved = await client.resolveCourtCode(trimmed);
  if (!resolved) {
    throw new Error(`Cannot resolve court from ${JSON.stringify(value)}`);
  }

  return resolved;
};

const renderCourtList = async (
  client: InfoSoudClient,
  flags: CliFlags,
): Promise<string> => {
  const courtMap = await client.buildCourtMap();

  if (flags.json) {
    return JSON.stringify(courtMap, null, 2);
  }

  if (flags.csv) {
    return serializeCourtMapCsv(courtMap);
  }

  const lines = Object.entries(courtMap)
    .toSorted((left, right) => left[1].localeCompare(right[1], "cs-CZ"))
    .map(([code, name]) => `${code}  ${name}`);

  lines.push("", `Celkem: ${lines.length} soudů`);
  return lines.join("\n");
};

const main = async (): Promise<void> => {
  try {
    const flags = parseArgs(process.argv.slice(2));

    if (flags.help) {
      printStdout(HELP_TEXT);
      return;
    }

    if (flags.json && flags.csv) {
      throw new Error("Use either --json or --csv, not both");
    }

    const client = new InfoSoudClient();

    if (flags.courtList) {
      printStdout(await renderCourtList(client, flags));
      return;
    }

    const spisInput = flags.positionals.at(0);
    const courtArg = flags.positionals.at(1);

    if (!spisInput) {
      throw new Error("Missing spisová značka");
    }

    const { courtReference, parsedSpisZn } = resolveCliLookupInput({
      courtArg,
      spisInput,
    });

    if (!courtReference) {
      throw new Error(
        "Court code is required. Pass it as the second argument, include it in the spisová značka, or use a resolvable court name.",
      );
    }

    const usesEmbeddedCourtCode =
      parsedSpisZn.courtCode !== undefined &&
      !courtArg &&
      courtReference === parsedSpisZn.courtCode;
    const resolvedCourtCode = usesEmbeddedCourtCode
      ? parsedSpisZn.courtCode
      : await resolveCourtReference(client, courtReference);

    if (flags.hearings) {
      const result = await client.searchHearings({
        courtCode: resolvedCourtCode,
        spisZn: parsedSpisZn,
      });

      printStdout(
        flags.json
          ? JSON.stringify(result, null, 2)
          : flags.csv
            ? serializeHearingsCsv(result)
            : formatHearingsSummary(result),
      );
      return;
    }

    const result = await client.searchCase({
      courtCode: resolvedCourtCode,
      spisZn: parsedSpisZn,
    });

    if (flags.json) {
      printStdout(JSON.stringify(result, null, 2));
      return;
    }

    if (flags.csv) {
      printStdout(serializeCaseEventsCsv(result));
      return;
    }

    printStdout(formatCaseSummary(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printStderr(`Error: ${message}`);
    process.exitCode = 1;
  }
};

void main();
