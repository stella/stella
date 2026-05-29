// Passive regression fixture for `stella-lowercase/stella-lowercase`.
//
// `oxlint-disable-next-line` below intentionally suppresses cases the
// rule MUST flag. If the rule regresses, the corresponding disable becomes
// unused and `--report-unused-disable-directives-severity=error` fails CI.
//
// Lines without a disable directive must continue to pass — they're the
// allow-list catalogue (sentence starts, code identifiers, asset
// filenames, import paths, post-newline starts, etc.).

// oxlint-disable-next-line stella-lowercase/stella-lowercase
const _midSentenceString = "Welcome to Stella";

const _midSentenceError = (): never => {
  // oxlint-disable-next-line stella-lowercase/stella-lowercase, no-bare-error/no-bare-error
  throw new Error("Request to Stella API failed");
};

const _midSentenceTemplate = (status: number): string =>
  // oxlint-disable-next-line stella-lowercase/stella-lowercase
  `Request to Stella failed with ${status}`;

// oxlint-disable-next-line stella-lowercase/stella-lowercase
const _periodButNotImmediate = "End. The Stella step";

const _jsxMidSentence = () => (
  <p>
    {/* oxlint-disable-next-line stella-lowercase/stella-lowercase */}
    Powered by Stella
  </p>
);

// oxlint-disable-next-line stella-lowercase/stella-lowercase
const _xmlMetadataMidString = "<Application>Stella</Application>";

// --- Cases that MUST NOT flag (no disable directives below) ---

const _stringStart = "Stella is loading";

const _afterPeriodSpace = "Workflow paused. Stella resumed";

const _afterExclamation = "Done! Stella will pick it up";

const _afterEllipsis = "Loading… Stella is checking";

const _kebabAssetName = "Stella-macos-universal.dmg";

const _bundleId = "Stella.app";

const _pathString = "/Applications/Stella.app/Contents/MacOS";

const _identifierString = "StellaMark";

const _camelInsideString = "FakeStellaApiOptions";

const _pascalSuffix = "createFakeStellaApi";

const _afterNewline = "Heading\nStella keeps going";

const _alreadyLowercase = "Welcome to stella";

export const __stellaLowercaseFixture = {
  _midSentenceString,
  _midSentenceError,
  _midSentenceTemplate,
  _periodButNotImmediate,
  _jsxMidSentence,
  _xmlMetadataMidString,
  _stringStart,
  _afterPeriodSpace,
  _afterExclamation,
  _afterEllipsis,
  _kebabAssetName,
  _bundleId,
  _pathString,
  _identifierString,
  _camelInsideString,
  _pascalSuffix,
  _afterNewline,
  _alreadyLowercase,
};
