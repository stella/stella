// Passive regression fixture for `no-secret-in-log-sink/no-secret-in-log-sink`.

declare const apiKey: string;
declare const captureError: (error: unknown, context: unknown) => void;
declare const credentials: { clientSecret: string };
declare const error: unknown;
declare const maskApiKey: (value: string) => string;

// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture proves secret object keys cannot enter serialization sinks
const serializedSecret = JSON.stringify({ apiKey });
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture proves member-access secrets cannot enter telemetry sinks
captureError(error, credentials.clientSecret);
// oxlint-disable-next-line no-secret-in-log-sink/no-secret-in-log-sink -- fixture proves Error-constructor templates cannot capture secret values
const secretError = new Error(`provider failed: ${apiKey}`);

const serializedConfig = JSON.stringify({ provider: "example" });
const maskedKey = JSON.stringify({ apiKey: maskApiKey(apiKey) });

export { maskedKey, secretError, serializedConfig, serializedSecret };
