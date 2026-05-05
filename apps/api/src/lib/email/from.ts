const TRANSACTIONAL_EMAIL_SENDER_NAME = "stella";

export const formatTransactionalEmailFrom = (fromAddress: string): string => {
  const trimmedAddress = fromAddress.trim();
  const addressStart = trimmedAddress.lastIndexOf("<");

  if (addressStart !== -1 && trimmedAddress.endsWith(">")) {
    const address = trimmedAddress.slice(addressStart + 1, -1).trim();
    return `${TRANSACTIONAL_EMAIL_SENDER_NAME} <${address}>`;
  }

  return `${TRANSACTIONAL_EMAIL_SENDER_NAME} <${trimmedAddress}>`;
};
