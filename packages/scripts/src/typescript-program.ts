import { panic } from "better-result";
import path from "node:path";
import ts from "typescript";

import { withoutTsgoOnlyOptionDiagnostics } from "./tsgo-compiler-options";

type CreateProgramOptions = {
  readonly configPath: string;
  readonly rootNames?: readonly string[];
};

export const createProgram = ({
  configPath,
  rootNames,
}: CreateProgramOptions): ts.Program => {
  const configFile = ts.readConfigFile(configPath, (file) =>
    ts.sys.readFile(file),
  );
  if (configFile.error !== undefined) {
    panic(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  const errors = withoutTsgoOnlyOptionDiagnostics(parsed.errors);
  if (errors.length > 0) {
    panic(
      errors
        .map(({ messageText }) =>
          ts.flattenDiagnosticMessageText(messageText, "\n"),
        )
        .join("\n"),
    );
  }

  const options = {
    rootNames:
      rootNames === undefined
        ? parsed.fileNames
        : [
            ...rootNames,
            ...parsed.fileNames.filter((file) => file.endsWith(".d.ts")),
          ],
    options: parsed.options,
  };
  if (parsed.projectReferences === undefined) {
    return ts.createProgram(options);
  }
  return ts.createProgram({
    ...options,
    projectReferences: parsed.projectReferences,
  });
};
