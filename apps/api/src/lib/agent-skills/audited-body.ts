/**
 * What an audit row keeps of a skill or proposal body. The revision history
 * holds the text; the audit trail records that it changed, how large it is,
 * and a digest that tells two versions apart without repeating the text.
 */
export type AuditedSkillBody = {
  sizeBytes: number;
  sha256: string;
};

const UTF8_ENCODER = new TextEncoder();

export const auditedSkillBody = (body: string): AuditedSkillBody => ({
  sizeBytes: UTF8_ENCODER.encode(body).byteLength,
  sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
});
