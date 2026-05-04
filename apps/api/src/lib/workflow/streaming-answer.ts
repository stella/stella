const MAX_STREAMED_ANSWER_CHARS = 500;

const truncateStreamedAnswer = (value: string): string => {
  const normalized = value.trim();
  const chars = Array.from(normalized);
  if (chars.length <= MAX_STREAMED_ANSWER_CHARS) {
    return normalized;
  }
  return chars.slice(0, MAX_STREAMED_ANSWER_CHARS).join("").trim();
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const formatPartialAnswer = (answer: unknown): string | null => {
  if (typeof answer === "string") {
    const text = truncateStreamedAnswer(answer);
    return text.length > 0 ? text : null;
  }

  if (typeof answer === "number" && Number.isFinite(answer)) {
    return String(answer);
  }

  if (Array.isArray(answer)) {
    const values = answer
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (values.length === 0) {
      return null;
    }

    return truncateStreamedAnswer(values.join(", "));
  }

  if (!isPlainObject(answer)) {
    return null;
  }

  const amount = answer["amount"];
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return null;
  }

  const currency = answer["currency"];
  if (typeof currency === "string" && currency.trim().length > 0) {
    return truncateStreamedAnswer(`${amount} ${currency}`);
  }

  return String(amount);
};

export type PartialAnswerUpdate = {
  propertyId: string;
  answer: string;
};

type ConsumePartialAnswersArgs = {
  partialOutputs: AsyncIterable<unknown> | Iterable<unknown>;
  propertyIds: readonly string[];
  onPartialAnswer: (update: PartialAnswerUpdate) => Promise<void> | void;
};

export const consumePartialAnswers = async ({
  partialOutputs,
  propertyIds,
  onPartialAnswer,
}: ConsumePartialAnswersArgs): Promise<void> => {
  for await (const partialOutput of partialOutputs) {
    if (!isPlainObject(partialOutput)) {
      continue;
    }

    for (const propertyId of propertyIds) {
      const propertyOutput = partialOutput[propertyId];
      if (!isPlainObject(propertyOutput) || !("answer" in propertyOutput)) {
        continue;
      }

      const answer = formatPartialAnswer(propertyOutput["answer"]);
      if (!answer) {
        continue;
      }

      await onPartialAnswer({ propertyId, answer });
    }
  }
};
