type AuthoredSkillContent = {
  body: string;
  description: string;
  name: string;
  version: string | null;
};

export const hashAuthoredSkillContent = ({
  body,
  description,
  name,
  version,
}: AuthoredSkillContent): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(name);
  hasher.update("\0");
  hasher.update(description);
  hasher.update("\0");
  hasher.update(version ?? "");
  hasher.update("\0");
  hasher.update(body);
  return hasher.digest("hex").slice(0, 64);
};
