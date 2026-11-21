declare const HandlerError: new (options: { message: string }) => object;
declare const ProviderCallError: new (options: {
  message?: string;
  provider: string;
}) => object;

declare const ModelRunError: new (options: {
  message?: string;
  model: string;
}) => object;

declare const chunk: { message: string };
const FIXED_MESSAGE = "Provider request failed";
// oxlint-disable-next-line provider-call-error-message/provider-call-error-message
const providerOptions: { message: string } = { message: chunk.message };

// accepted: application-owned constant
// expect-clean: provider-call-error-message/provider-call-error-message
const acceptedHandlerError = new HandlerError({ message: FIXED_MESSAGE });

// accepted: provider error message is supplied by the owning constructor
// expect-clean: provider-call-error-message/provider-call-error-message
const acceptedProviderCallError = new ProviderCallError({
  provider: "openrouter",
});

// flagged: a provider run-error value cannot become a HandlerError message
// oxlint-disable-next-line provider-call-error-message/provider-call-error-message
const rejectedHandlerError = new HandlerError({ message: chunk.message });

// flagged: callers do not supply ProviderCallError messages
const rejectedProviderMessage = new ProviderCallError({
  provider: "openrouter",
  // oxlint-disable-next-line provider-call-error-message/provider-call-error-message
  message: chunk.message,
});

// accepted: the model run error supplies its own message
// expect-clean: provider-call-error-message/provider-call-error-message
const acceptedModelRunError = new ModelRunError({ model: "openrouter" });

// flagged: callers do not supply ModelRunError messages
const rejectedModelRunMessage = new ModelRunError({
  model: "openrouter",
  // oxlint-disable-next-line provider-call-error-message/provider-call-error-message
  message: chunk.message,
});

// flagged: a message remains forbidden through an object spread
const rejectedSpreadMessage = new ProviderCallError({
  provider: "openrouter",
  ...providerOptions,
});

export const fixtureValues = [
  acceptedHandlerError,
  acceptedProviderCallError,
  rejectedHandlerError,
  rejectedProviderMessage,
  rejectedSpreadMessage,
  acceptedModelRunError,
  rejectedModelRunMessage,
];
