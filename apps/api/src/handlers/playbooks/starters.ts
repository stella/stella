import type {
  PlaybookPositions,
  PositionSeverity,
} from "@/api/handlers/playbooks/positions";

// Ready-made playbooks a user can instantiate into their org in one click, so
// review has day-1 value instead of a blank editor. Content here is a
// starting point the user is expected to tailor (thresholds, currencies,
// jurisdiction-specific language) — not legal advice.
//
// `sourceId` and every tier-rule/fallback-entry `id` below are FIXED
// placeholders (distinct only within their own playbook): `from-starter.ts`
// clones this constant and replaces every one of them with a fresh
// `crypto.randomUUID()` before the playbook is created, so no instantiated
// org ever ends up with two playbooks (or two positions) sharing an id.

export const STARTER_PLAYBOOK_IDS = ["nda", "dpa", "msa"] as const;
export type StarterPlaybookId = (typeof STARTER_PLAYBOOK_IDS)[number];

export type StarterPlaybook = {
  starterId: StarterPlaybookId;
  name: string;
  description: string;
  documentTypeKey: string;
  positions: PlaybookPositions;
};

// ── Placeholder id helper ────────────────────────────
// A valid-shaped (8-4-4-4-12 hex) but obviously-fake uuid, scoped per playbook
// by `prefix` so a placeholder can never collide across the three starters
// even before regeneration. Decimal digits are valid hex, so a zero-padded
// counter is enough.
const placeholderId = (prefix: number, sequence: number): string =>
  `00000000-0000-4000-${prefix.toString().padStart(4, "0")}-${sequence
    .toString()
    .padStart(12, "0")}`;

type StarterTierInput = {
  acceptable: string[];
  ideal: string;
  fallback: { text: string; label?: string }[];
  notAcceptable: string[];
};

type StarterNegotiationInput = {
  rationale: string;
  talkingPoints: string[];
  escalation: string;
};

type StarterPositionInput = {
  issue: string;
  severity: PositionSeverity;
  tiers: StarterTierInput;
  negotiation: StarterNegotiationInput;
};

// Builds one GRADED position, threading a per-playbook id counter through the
// sourceId and every tier-rule/fallback-entry id so they stay distinct within
// the playbook (uniqueness across playbooks does not matter: every id is
// replaced on instantiate).
const buildGradedPosition = (
  prefix: number,
  counter: { next: number },
  input: StarterPositionInput,
): PlaybookPositions["items"][number] => {
  const nextId = (): string => {
    const id = placeholderId(prefix, counter.next);
    counter.next += 1;
    return id;
  };

  return {
    mode: "graded",
    sourceId: nextId(),
    issue: input.issue,
    severity: input.severity,
    enabled: true,
    ask: { mode: "auto" },
    tiers: {
      acceptable: {
        rules: input.tiers.acceptable.map((text) => ({ id: nextId(), text })),
        ideal: { source: "inline", text: input.tiers.ideal },
      },
      fallback: {
        entries: input.tiers.fallback.map((entry) => {
          const id = nextId();
          if (entry.label === undefined) {
            return { id, text: entry.text };
          }
          return { id, text: entry.text, label: entry.label };
        }),
      },
      notAcceptable: {
        rules: input.tiers.notAcceptable.map((text) => ({
          id: nextId(),
          text,
        })),
      },
    },
    negotiation: {
      rationale: input.negotiation.rationale,
      talkingPoints: input.negotiation.talkingPoints,
      escalation: input.negotiation.escalation,
    },
  };
};

const buildStarterPositions = (
  prefix: number,
  inputs: StarterPositionInput[],
): PlaybookPositions => {
  const counter = { next: 1 };
  return {
    version: 2,
    items: inputs.map((input) => buildGradedPosition(prefix, counter, input)),
  };
};

// ── NDA ───────────────────────────────────────────────

const NDA_POSITIONS: StarterPositionInput[] = [
  {
    issue: "Mutual vs one-way confidentiality obligations",
    severity: "high",
    tiers: {
      acceptable: [
        "Obligations apply equally to both parties (mutual NDA)",
        "If one-way, the disclosing party is clearly identified and the receiving party's use is limited to evaluating the contemplated transaction",
      ],
      ideal:
        "Each party may act as a Disclosing Party or a Receiving Party under this Agreement, and the obligations in this Section apply equally regardless of which role a party occupies at a given time.",
      fallback: [
        {
          label: "One-way with a carve-back",
          text: "The Agreement is one-way, but the Receiving Party's own pre-existing and independently developed information is expressly excluded from the Confidential Information it discloses.",
        },
      ],
      notAcceptable: [
        "A one-way NDA that binds only the counterparty's employees or agents, not the counterparty itself",
        "No carve-outs at all for a one-way agreement",
      ],
    },
    negotiation: {
      rationale:
        "A one-way NDA that turns out to be mutual in practice (both sides will share sensitive information) leaves your own disclosures unprotected.",
      talkingPoints: [
        "Confirm which party will actually be disclosing information in practice; if both will, the NDA should be mutual.",
        "A one-way NDA is acceptable when only one side is truly sharing sensitive information (e.g. a due-diligence data room).",
      ],
      escalation:
        "Escalate if the counterparty insists on a one-way NDA while requesting your confidential information too.",
    },
  },
  {
    issue: "Definition of Confidential Information and standard carve-outs",
    severity: "blocker",
    tiers: {
      acceptable: [
        "Confidential Information is defined broadly (any information disclosed, whether oral, written, or visual) and marked, or reasonably understood, as confidential",
        "Standard carve-outs apply: information that is public, independently developed, rightfully received from a third party, or already known before disclosure",
      ],
      ideal:
        '"Confidential Information" means any non-public information disclosed by or on behalf of the Disclosing Party, whether orally, in writing, or in any other form, that is designated as confidential or that a reasonable person would understand to be confidential given the nature of the information and the circumstances of disclosure. Confidential Information does not include information that: (a) is or becomes publicly available through no fault of the Receiving Party; (b) was already known to the Receiving Party before disclosure without an obligation of confidentiality; (c) is independently developed by the Receiving Party without use of the Confidential Information; or (d) is rightfully received from a third party without breach of any confidentiality obligation.',
      fallback: [
        {
          label: "Marking required for oral disclosures",
          text: "Oral or visual disclosures must be confirmed in writing as confidential within 10-15 business days of disclosure to remain protected.",
        },
      ],
      notAcceptable: [
        "No carve-outs at all (independently developed or public information would still count as confidential)",
        "The definition is scoped so narrowly that ordinary business information actually discussed is not covered",
      ],
    },
    negotiation: {
      rationale:
        "The definition is the foundation of the whole agreement: too broad and everything ever mentioned becomes a restricted secret; too narrow (or missing standard carve-outs) and the receiving party is exposed to claims over information it never should have had to protect.",
      talkingPoints: [
        "The four standard carve-outs (public, prior knowledge, independent development, third-party source) are market-standard; their absence is a red flag, not a negotiating position.",
        "Push back on any requirement that oral disclosures are confidential from the moment of disclosure with no written confirmation window — it is unworkable in practice.",
      ],
      escalation:
        "Escalate if the counterparty refuses to include the standard carve-outs, since that shifts real risk onto the receiving party's ordinary business operations.",
    },
  },
  {
    issue: "Term and duration of confidentiality obligations",
    severity: "medium",
    tiers: {
      acceptable: [
        "Confidentiality obligations survive for two to three years after disclosure or termination",
        "Trade secrets remain protected for as long as they qualify as a trade secret under applicable law",
      ],
      ideal:
        "This Agreement remains in effect for one (1) year from the Effective Date. The confidentiality obligations in this Agreement survive for three (3) years following the date of disclosure of the applicable Confidential Information, except that obligations relating to trade secrets continue for as long as the information qualifies as a trade secret under applicable law.",
      fallback: [
        {
          label: "Shorter survival with a trade-secret carve-out",
          text: "A one to two year survival period is acceptable provided trade secrets remain protected for as long as they qualify as such under applicable law.",
        },
      ],
      notAcceptable: [
        "Confidentiality obligations end immediately on termination of the agreement, with no survival period",
        "Perpetual confidentiality with no trade-secret limitation and no sunset for ordinary business information",
      ],
    },
    negotiation: {
      rationale:
        "Too short a survival period lets old secrets go stale into the public domain before they lose commercial sensitivity; perpetual confidentiality with no trade-secret distinction is an unbounded, unenforceable-in-practice obligation.",
      talkingPoints: [
        "A two to three year survival period after disclosure is the common market range for ordinary business confidential information.",
        "Trade secrets should be carved out and protected indefinitely (or for as long as they remain a trade secret), since that is what the underlying law already provides.",
      ],
      escalation:
        "Escalate a request for perpetual confidentiality over all information (not just trade secrets) to determine whether that risk is acceptable for this relationship.",
    },
  },
  {
    issue: "Permitted disclosures to representatives, advisors, and by law",
    severity: "medium",
    tiers: {
      acceptable: [
        "Disclosure permitted to employees, officers, and professional advisors on a need-to-know basis, bound by confidentiality obligations at least as protective as this Agreement",
        "Disclosure required by law or court order is permitted, with prior notice to the disclosing party where legally possible",
      ],
      ideal:
        "The Receiving Party may disclose Confidential Information to its employees, officers, directors, and professional advisors who need to know it for the purposes of this Agreement and who are bound by confidentiality obligations at least as protective as those in this Agreement. The Receiving Party may also disclose Confidential Information to the extent required by law, regulation, or court order, provided it gives the Disclosing Party prompt written notice (where legally permitted) so the Disclosing Party may seek a protective order.",
      fallback: [
        {
          label: "No advance notice for compelled disclosure",
          text: "Disclosure compelled by law is permitted without prior notice, provided the Receiving Party discloses only the minimum required and, where practicable, notifies the Disclosing Party promptly after disclosure.",
        },
      ],
      notAcceptable: [
        "Any disclosure to advisors or affiliates is prohibited outright, even when they are bound by confidentiality obligations",
        "No exception at all for legally compelled disclosure, creating an impossible compliance conflict",
      ],
    },
    negotiation: {
      rationale:
        "Every real organization needs to share confidential information internally and with advisors to actually use it, and every organization is sometimes legally compelled to disclose; an NDA that does not accommodate either is unworkable.",
      talkingPoints: [
        "Confirm advisors and affiliates are covered as long as they are bound by equivalent confidentiality terms.",
        "A notice requirement for compelled disclosure should not block the disclosure itself where notice is not legally permitted (e.g. a sealed subpoena).",
      ],
      escalation:
        "Escalate if the counterparty refuses any legally-compelled-disclosure exception.",
    },
  },
  {
    issue: "Return or destruction of Confidential Information",
    severity: "low",
    tiers: {
      acceptable: [
        "On request or termination, the Receiving Party returns or destroys Confidential Information within a reasonable period (10-30 days)",
        "Destruction may be certified in writing; a limited archival copy retained for legal or compliance purposes is permitted",
      ],
      ideal:
        "Upon the Disclosing Party's written request, or upon termination of this Agreement, the Receiving Party will promptly (and in any event within thirty (30) days) return or destroy all Confidential Information in its possession, and certify such destruction in writing if requested, except that the Receiving Party may retain one copy in its legal archives solely to demonstrate compliance with this Agreement or as required by law.",
      fallback: [
        {
          label: "Retention on backup systems",
          text: "Copies retained on backup or disaster-recovery systems in the ordinary course of automated archiving are exempt, provided they remain subject to confidentiality and are not restored for active use.",
        },
      ],
      notAcceptable: [
        "No return or destruction obligation at all",
        "A return/destroy requirement with no allowance for standard backup archival retention or an active legal hold",
      ],
    },
    negotiation: {
      rationale:
        "A hard, absolute destruction requirement is often technically impossible (automated backups, legal holds) and manufactures a breach out of ordinary IT practice.",
      talkingPoints: [
        "A 30-day return/destroy window with a backup-system carve-out is standard and should not be controversial.",
        "Legal-hold and regulatory-retention exceptions protect both parties from an unintentional breach.",
      ],
      escalation:
        "Escalate only if the counterparty refuses any backup or legal-hold carve-out, since that creates an unmeetable obligation.",
    },
  },
  {
    issue: "No implied license and no warranty on Confidential Information",
    severity: "medium",
    tiers: {
      acceptable: [
        "Disclosure does not grant any license, right, or interest in the Confidential Information or any underlying intellectual property",
        'Confidential Information is provided "as is" with no warranty as to its accuracy or completeness',
      ],
      ideal:
        'No license or other right, express or implied, is granted by this Agreement to the Receiving Party under any patent, copyright, trade secret, or other intellectual property right of the Disclosing Party. All Confidential Information is provided "as is," and the Disclosing Party makes no representation or warranty as to its accuracy or completeness.',
      fallback: [
        {
          label: "Limited license for the stated purpose",
          text: "A narrow, non-exclusive license to use the Confidential Information solely to evaluate the contemplated transaction is acceptable, with no broader intellectual-property rights conveyed.",
        },
      ],
      notAcceptable: [
        "Silence on intellectual-property ownership, creating ambiguity over whether disclosure conveys rights",
        "The disclosing party warrants the accuracy or completeness of the Confidential Information, creating liability exposure it should not accept for a preliminary exchange",
      ],
    },
    negotiation: {
      rationale:
        "Without this clause, sharing information for a preliminary discussion could later be read as granting rights to use it, or as a warranty the disclosing party never intended to make.",
      talkingPoints: [
        "This is boilerplate protecting the disclosing party; it should not need heavy negotiation.",
        "If the receiving party genuinely needs a license (e.g. to evaluate a technical demo), scope it narrowly to the stated purpose only.",
      ],
      escalation:
        "Escalate if the counterparty asks the disclosing party to warrant the accuracy of the information it shares.",
    },
  },
  {
    issue: "Right to seek injunctive relief for breach",
    severity: "medium",
    tiers: {
      acceptable: [
        "Either party may seek injunctive or other equitable relief for actual or threatened breach, in addition to any other available remedy",
        "No requirement to post a bond as a precondition to seeking equitable relief, where permitted by law",
      ],
      ideal:
        "Each party acknowledges that a breach of this Agreement may cause irreparable harm for which monetary damages would be an inadequate remedy, and that the non-breaching party is entitled to seek injunctive or other equitable relief, in addition to any other remedies available at law or in equity, without the need to post a bond except as required by applicable law.",
      fallback: [],
      notAcceptable: [
        "No equitable-relief remedy at all, forcing a claimant to prove monetary damages for a harm (loss of confidentiality) that is inherently difficult to quantify",
      ],
    },
    negotiation: {
      rationale:
        "Confidentiality breaches often cause harm that money cannot undo (a trade secret becoming public); without an equitable-relief clause, a party may be limited to slow, hard-to-prove damages claims after the harm is already done.",
      talkingPoints: [
        "This clause does not change the standard for obtaining an injunction under applicable law; it just confirms both parties agree the remedy is available.",
      ],
      escalation:
        "Escalate if the counterparty wants to expressly waive equitable relief.",
    },
  },
  {
    issue: "Governing law and jurisdiction",
    severity: "low",
    tiers: {
      acceptable: [
        "Governing law is a jurisdiction with well-developed confidentiality or trade-secret law, and is neutral to both parties or the disclosing party's home jurisdiction",
        "Exclusive jurisdiction of the courts in the specified location",
      ],
      ideal:
        "This Agreement is governed by the laws of [Jurisdiction], without regard to its conflict-of-laws principles. The parties submit to the exclusive jurisdiction of the courts located in [Jurisdiction] for any dispute arising out of or relating to this Agreement.",
      fallback: [
        {
          label: "Neutral third jurisdiction",
          text: "A neutral jurisdiction with well-developed confidentiality law, agreed by both parties, is acceptable even if it is neither party's home jurisdiction.",
        },
      ],
      notAcceptable: [
        "Governing law of a jurisdiction with no meaningful confidentiality or trade-secret protection",
        "Mandatory arbitration seated in a jurisdiction with no connection to either party and no reciprocal enforcement of awards",
      ],
    },
    negotiation: {
      rationale:
        "Confidentiality protection is only as strong as the law that enforces it; a jurisdiction with weak trade-secret law undermines the whole agreement regardless of how well the clauses are drafted.",
      talkingPoints: [
        "Your home jurisdiction (or a well-known commercial-law jurisdiction) is the default ask; a neutral jurisdiction with strong IP/trade-secret law is a reasonable fallback.",
      ],
      escalation:
        "Escalate a proposed jurisdiction with weak or untested confidentiality/trade-secret enforcement to your legal team before agreeing.",
    },
  },
];

// ── DPA ───────────────────────────────────────────────

const DPA_POSITIONS: StarterPositionInput[] = [
  {
    issue: "Controller and processor roles are clearly assigned",
    severity: "blocker",
    tiers: {
      acceptable: [
        "The Agreement expressly designates each party's role (controller, processor, or joint controller) for each processing activity",
        "The processor processes personal data only on documented instructions from the controller, including for international transfers",
      ],
      ideal:
        "For the purposes of this Agreement and applicable data protection law, [Customer] is the Controller and [Vendor] is the Processor with respect to the personal data processed under this Agreement. The Processor will process personal data only on documented instructions from the Controller, including with regard to transfers of personal data to a third country, unless required to do otherwise by law applicable to the Processor.",
      fallback: [
        {
          label: "Sub-processor acting as processor too",
          text: "Where the counterparty acts as a sub-processor to another processor, its role and the party instructing it are identified in this Agreement or its annex.",
        },
      ],
      notAcceptable: [
        "No role designation at all: the Agreement is silent on who is controller and who is processor",
        "The processor reserves the right to determine the purposes and means of processing (this makes it a controller, defeating the point of the DPA)",
      ],
    },
    negotiation: {
      rationale:
        "Every other obligation in a DPA (instructions, sub-processing, breach notice, deletion) hangs off the controller/processor designation; without it, neither party's downstream compliance obligations are clear.",
      talkingPoints: [
        "Confirm the processor commits to acting only on the controller's documented instructions, not on its own initiative.",
        "Flag any clause letting the processor use personal data for its own separate purposes — that is controller behaviour, not processor behaviour.",
      ],
      escalation:
        "Escalate any request for the processor to process data beyond the controller's instructions (e.g. for the processor's own product improvement).",
    },
  },
  {
    issue: "Engagement and flow-down of sub-processors",
    severity: "high",
    tiers: {
      acceptable: [
        "The processor maintains a current list of sub-processors and gives prior notice of changes, with a right to object",
        "The processor flows down data-protection obligations to sub-processors under a written contract at least as protective as this Agreement",
      ],
      ideal:
        "The Processor may engage sub-processors to carry out specific processing activities on behalf of the Controller, provided the Processor: (a) maintains an up-to-date list of sub-processors, made available to the Controller; (b) gives the Controller at least fourteen (14) days' prior written notice of any new sub-processor, during which the Controller may object on reasonable data-protection grounds; and (c) imposes data-protection obligations on each sub-processor that are at least as protective as those in this Agreement, and remains fully liable for each sub-processor's performance.",
      fallback: [
        {
          label: "General authorization with notice",
          text: "General written authorization for sub-processors is acceptable provided the processor gives at least 14-30 days' prior notice of any new sub-processor and a mechanism to object.",
        },
      ],
      notAcceptable: [
        "The processor may engage any sub-processor without notice or flow-down obligations",
        "No right to object to a new sub-processor under any circumstance",
      ],
    },
    negotiation: {
      rationale:
        "The controller remains accountable to regulators and data subjects for how sub-processors handle the data, even though it has no direct contract with them; notice and flow-down obligations are how that accountability stays enforceable.",
      talkingPoints: [
        "A prior-notice-and-object mechanism (rather than case-by-case pre-approval) is the market-standard middle ground for an ongoing vendor relationship with many sub-processors.",
        "The processor should remain liable for its sub-processors' acts as if they were its own.",
      ],
      escalation:
        "Escalate if the processor refuses any notice mechanism for new sub-processors, or refuses to remain liable for their performance.",
    },
  },
  {
    issue: "Technical and organizational security measures (TOMs)",
    severity: "blocker",
    tiers: {
      acceptable: [
        "The processor implements appropriate technical and organizational measures (encryption at rest and in transit, access controls, logging) appropriate to the risk",
        "The measures are documented in an annex or exhibit and cannot be materially downgraded during the term",
      ],
      ideal:
        "The Processor will implement and maintain appropriate technical and organizational measures to protect personal data against accidental or unlawful destruction, loss, alteration, unauthorized disclosure, or access, as set out in Annex [X]. The Processor will not materially decrease the overall security of these measures during the term of this Agreement.",
      fallback: [
        {
          label: "Recognized security standard in lieu of an itemized annex",
          text: "Reference to compliance with a recognized security standard (such as ISO 27001 or SOC 2) is acceptable in lieu of a fully itemized measures annex, provided a current certificate or report is made available on request.",
        },
      ],
      notAcceptable: [
        "No described security measures at all, or only a vague 'commercially reasonable efforts' standard with no substantive content",
        "The processor may unilaterally change its security measures without notice, including downgrades",
      ],
    },
    negotiation: {
      rationale:
        "Security measures are the practical substance behind the paperwork; a DPA with strong legal language but no real security commitment does not actually protect the data.",
      talkingPoints: [
        "Ask for the specific annex or a recognized third-party certification (ISO 27001, SOC 2) rather than accepting generic language.",
        "A no-downgrade commitment during the term protects against the vendor quietly cutting corners after signature.",
      ],
      escalation:
        "Escalate if the vendor cannot describe its security measures at all, or refuses to commit to not downgrading them.",
    },
  },
  {
    issue: "Personal data breach notification timing",
    severity: "blocker",
    tiers: {
      acceptable: [
        "The processor notifies the controller without undue delay, and no later than 48-72 hours after becoming aware of a personal data breach",
        "Notification includes the nature of the breach, the categories and approximate number of data subjects and records affected, and mitigation steps taken",
      ],
      ideal:
        "The Processor will notify the Controller without undue delay, and in any event no later than forty-eight (48) hours, after becoming aware of a personal data breach affecting personal data processed under this Agreement. The notification will describe, to the extent then known: the nature of the breach; the categories and approximate number of data subjects and personal data records concerned; the likely consequences; and the measures taken or proposed to address the breach and mitigate its effects.",
      fallback: [
        {
          label: "Longer window with an immediate informal notice",
          text: "A formal notice window of up to five (5) business days is acceptable only if paired with an immediate informal notice (e.g. by phone or email) as soon as the processor becomes aware of the breach.",
        },
      ],
      notAcceptable: [
        "No defined notification window at all, leaving the controller unable to meet its own regulatory reporting deadline",
        "A notification window longer than the controller's own statutory reporting deadline, with no interim informal-notice mechanism",
      ],
    },
    negotiation: {
      rationale:
        "The controller typically has a strict regulatory deadline (often 72 hours) to report a breach to a supervisory authority; if the processor's contractual notice window eats most or all of that time, the controller may miss its own legal deadline through no fault of its own.",
      talkingPoints: [
        "48 hours is a reasonable ask given many controllers must report within 72 hours of becoming aware.",
        "An immediate informal heads-up (even before all details are known) preserves the controller's ability to assess and report on time.",
      ],
      escalation:
        "Escalate any breach-notice window that would leave the controller unable to meet its own statutory reporting deadline.",
    },
  },
  {
    issue: "Cross-border transfer mechanism (SCCs or equivalent)",
    severity: "high",
    tiers: {
      acceptable: [
        "Transfers outside the originating jurisdiction rely on Standard Contractual Clauses, or another recognized transfer mechanism, incorporated by reference",
        "The processor identifies the countries or regions where personal data will be processed or stored",
      ],
      ideal:
        "To the extent the Processor transfers personal data outside [the originating jurisdiction], the parties agree that the Standard Contractual Clauses (or another legally recognized transfer mechanism) are incorporated by reference and apply to such transfers. The Processor will disclose, on request, the countries or regions in which personal data is processed or stored.",
      fallback: [
        {
          label: "Reliance on an applicable adequacy decision",
          text: "Reliance on an applicable adequacy decision is acceptable in lieu of Standard Contractual Clauses where one currently covers the destination jurisdiction, with the Standard Contractual Clauses applying automatically if that adequacy decision is withdrawn.",
        },
      ],
      notAcceptable: [
        "No transfer mechanism specified at all, even though processing occurs outside the originating jurisdiction",
        "The processor may relocate processing to any country at its discretion, with no notice and no transfer safeguard",
      ],
    },
    negotiation: {
      rationale:
        "An international transfer without a valid legal mechanism (SCCs, adequacy decision, or equivalent) is itself a compliance gap for the controller, independent of how secure the processor's systems are.",
      talkingPoints: [
        "Ask exactly where the data will be processed and stored, and confirm the applicable transfer mechanism covers that specific route.",
        "An adequacy-decision fallback is fine as long as SCCs apply automatically if that decision is later withdrawn.",
      ],
      escalation:
        "Escalate if the vendor cannot confirm where data is processed, or has no transfer mechanism for a jurisdiction it uses.",
    },
  },
  {
    issue: "Controller's audit and inspection rights",
    severity: "medium",
    tiers: {
      acceptable: [
        "The controller may audit, or request evidence of compliance (such as a recent third-party certification or report), at reasonable intervals with reasonable notice",
        "The processor cooperates with regulatory audits and inspections",
      ],
      ideal:
        "The Processor will make available to the Controller all information reasonably necessary to demonstrate compliance with this Agreement, and will allow for and contribute to audits, including inspections, conducted by the Controller (or an auditor mandated by the Controller) at reasonable intervals on reasonable prior written notice, and will cooperate with any audit or inspection conducted by a competent supervisory authority.",
      fallback: [
        {
          label: "Independent audit report in lieu of an on-site audit",
          text: "Providing a recent independent audit report (such as a SOC 2 Type II report) in lieu of an on-site audit is acceptable, with an on-site audit available only following a substantiated security incident.",
        },
      ],
      notAcceptable: [
        "No audit or verification right whatsoever, even on reasonable notice",
        "Audit rights subject to the processor's unilateral approval with no minimum standard (e.g. the processor may refuse any audit request at its sole discretion)",
      ],
    },
    negotiation: {
      rationale:
        "The controller remains accountable for the processor's compliance and needs some way to verify it beyond taking the processor's word for it, but a full on-site audit right for every customer is often impractical for the vendor to grant to everyone.",
      talkingPoints: [
        "A recent, credible third-party report (SOC 2, ISO 27001) covering the relevant controls is usually sufficient in practice and is faster for both sides than a bespoke audit.",
        "Reserve the right to a fuller audit specifically after an incident, when the report alone is not enough.",
      ],
      escalation:
        "Escalate if the vendor cannot produce any third-party assurance report and also refuses any audit right.",
    },
  },
  {
    issue: "Return or deletion of personal data on termination",
    severity: "high",
    tiers: {
      acceptable: [
        "On termination or expiry, the processor returns and/or deletes all personal data, including copies, within a defined period (30-90 days), except where retention is required by law",
        "The processor certifies deletion in writing on request",
      ],
      ideal:
        "Upon termination or expiry of this Agreement, the Processor will, at the Controller's election, return or delete all personal data processed on behalf of the Controller (including existing copies) within thirty (30) days, except to the extent applicable law requires the Processor to retain some or all of the personal data, in which case the Processor will continue to protect it under the terms of this Agreement. The Processor will certify such deletion in writing on the Controller's request.",
      fallback: [
        {
          label: "Retention for an active legal hold",
          text: "Retention beyond the deletion window is acceptable solely to comply with a legal obligation or an active legal hold, with the retained data isolated from further active processing.",
        },
      ],
      notAcceptable: [
        "No deletion or return obligation at termination at all, allowing indefinite retention",
        "The processor may retain personal data indefinitely for its own commercial purposes after termination",
      ],
    },
    negotiation: {
      rationale:
        "Without a defined end-of-relationship deletion obligation, the controller has no way to demonstrate to a regulator or data subject that personal data does not simply linger with a former vendor indefinitely.",
      talkingPoints: [
        "A 30-90 day return-or-delete window with a written certification is standard.",
        "A legal-hold carve-out is reasonable, but the retained data should not be used for anything other than complying with that hold.",
      ],
      escalation:
        "Escalate if the vendor wants to retain personal data after termination for its own ongoing use (e.g. analytics, model training).",
    },
  },
];

// ── MSA ───────────────────────────────────────────────

const MSA_POSITIONS: StarterPositionInput[] = [
  {
    issue: "Aggregate liability cap and standard carve-outs",
    severity: "blocker",
    tiers: {
      acceptable: [
        "Aggregate liability is capped at a defined multiple of fees paid (e.g. the fees paid in the 12 months before the claim) for the relevant claim",
        "Standard carve-outs from the cap for gross negligence, willful misconduct, confidentiality breaches, and IP-indemnification obligations",
      ],
      ideal:
        "Except for the carve-outs below, each party's aggregate liability arising out of or related to this Agreement will not exceed the fees paid or payable by Customer in the twelve (12) months preceding the event giving rise to the claim. The cap in this Section does not apply to: (a) a party's gross negligence or willful misconduct; (b) breach of confidentiality obligations; or (c) a party's indemnification obligations under this Agreement.",
      fallback: [
        {
          label: "Higher cap for confidentiality and data-breach claims",
          text: "A higher cap (for example, two times the fees paid in the preceding 12 months) applying specifically to confidentiality and data-breach claims, with the standard cap applying to all other claims, is acceptable.",
        },
      ],
      notAcceptable: [
        "No liability cap at all for the vendor, exposing it to unlimited damages",
        "A cap so low (e.g. a token or nominal amount) that it is not a meaningful allocation of risk relative to the contract value",
      ],
    },
    negotiation: {
      rationale:
        "The liability cap is usually the single most consequential clause in a commercial agreement: it defines the maximum financial exposure either side is accepting, independent of what actually goes wrong.",
      talkingPoints: [
        "A 12-months'-fees cap is a widely used commercial benchmark and a reasonable starting point for most engagements.",
        "The standard carve-outs (gross negligence, willful misconduct, confidentiality, IP indemnity) should not themselves be capped, since they represent the risks the cap is not meant to cover.",
      ],
      escalation:
        "Escalate any request for an uncapped liability position, or a cap set below a level that would meaningfully compensate a realistic worst-case claim.",
    },
  },
  {
    issue: "Mutual indemnification for third-party claims",
    severity: "high",
    tiers: {
      acceptable: [
        "Each party indemnifies the other for third-party claims arising from its own breach, gross negligence, or willful misconduct",
        "The vendor separately indemnifies the customer for third-party IP-infringement claims arising from authorized use of the deliverables",
      ],
      ideal:
        "Each party will indemnify, defend, and hold harmless the other party from and against any third-party claim arising out of the indemnifying party's breach of this Agreement, gross negligence, or willful misconduct. In addition, Vendor will indemnify, defend, and hold harmless Customer from any third-party claim that the deliverables, as provided and used in accordance with this Agreement, infringe that third party's intellectual property rights.",
      fallback: [
        {
          label:
            "One-way IP indemnity paired with mutual confidentiality indemnity",
          text: "A one-way indemnity limited to the vendor's IP infringement of its deliverables is acceptable if paired with mutual indemnification for confidentiality and data-protection breaches.",
        },
      ],
      notAcceptable: [
        "No indemnification obligation at all, leaving each party to bear its own third-party claim exposure regardless of fault",
        "The customer indemnifies the vendor for IP infringement arising from the vendor's own deliverables",
      ],
    },
    negotiation: {
      rationale:
        "Indemnification allocates the cost of a third party's lawsuit, which is a different (and often larger) risk than a direct dispute between the two contracting parties; it should track fault, not be assigned to whichever party has less negotiating leverage.",
      talkingPoints: [
        "IP-infringement indemnity for the vendor's own deliverables is standard: the customer cannot control what the vendor builds, so it should not bear that risk.",
        "Mutual indemnity for each party's own breach/negligence keeps the allocation symmetric.",
      ],
      escalation:
        "Escalate if the vendor wants the customer to indemnify it for claims arising from the vendor's own deliverables or conduct.",
    },
  },
  {
    issue: "Ownership of background IP, deliverables, and work product",
    severity: "blocker",
    tiers: {
      acceptable: [
        "Each party retains ownership of its pre-existing background IP; new work product created specifically for the customer under the engagement is owned by, or exclusively licensed to, the customer",
        "The vendor retains ownership of its general tools, methodologies, and reusable components that are not specific to the customer's deliverables",
      ],
      ideal:
        'Each party retains all right, title, and interest in and to its Background IP (intellectual property owned or licensed by that party prior to, or independent of, this Agreement). Subject to full payment, Customer will own all right, title, and interest in the deliverables created specifically for Customer under this Agreement (the "Work Product"), excluding any Vendor Background IP incorporated into the Work Product, which Vendor licenses to Customer on a perpetual, worldwide, royalty-free basis solely as needed to use the Work Product for its intended purpose.',
      fallback: [
        {
          label: "Exclusive license instead of assignment",
          text: "A perpetual, irrevocable, royalty-free, exclusive license to the customer-specific Work Product is acceptable in lieu of a full assignment, provided the vendor may not license the same deliverable to the customer's competitors.",
        },
      ],
      notAcceptable: [
        "The vendor retains ownership of all deliverables and work product with no license grant to the customer at all",
        "The Agreement leaves background versus foreground IP ambiguous, with no allocation rule",
      ],
    },
    negotiation: {
      rationale:
        "IP ownership determines who can use, modify, resell, or license the output of the engagement after it ends; getting this wrong either strips the customer of the value it paid for, or strips the vendor of tools it needs across all of its customers.",
      talkingPoints: [
        "Customer-specific deliverables should belong to (or be fully licensed to) the customer; the vendor's general tools and reusable components should stay the vendor's.",
        "An exclusive license is often commercially equivalent to an assignment for the customer's practical purposes, and can be an easier ask of the vendor.",
      ],
      escalation:
        "Escalate if the vendor refuses any ownership or license grant over deliverables the customer specifically paid to have built.",
    },
  },
  {
    issue: "Termination rights, notice, and effects of termination",
    severity: "high",
    tiers: {
      acceptable: [
        "Either party may terminate for an uncured material breach after a defined cure period (e.g. 30 days' written notice)",
        "The customer may terminate for convenience on reasonable notice (30-90 days), subject to paying for services performed to date",
      ],
      ideal:
        "Either party may terminate this Agreement upon written notice if the other party materially breaches this Agreement and fails to cure such breach within thirty (30) days after receiving written notice describing the breach. Customer may also terminate this Agreement for convenience upon sixty (60) days' prior written notice, in which case Customer will pay for all services properly performed through the effective date of termination.",
      fallback: [
        {
          label: "No termination for convenience with a short initial term",
          text: "No termination-for-convenience right is acceptable provided the initial term is reasonably short (12 months or less) with an opt-out available at each renewal.",
        },
      ],
      notAcceptable: [
        "No cure period at all before either party may terminate for breach",
        "The vendor may terminate for convenience with no notice, disrupting the customer's operations with no transition period",
      ],
    },
    negotiation: {
      rationale:
        "Termination terms determine how much runway each side has to fix a problem, or to transition away, before the relationship actually ends; asymmetric or notice-free termination rights create operational risk for whichever side has fewer options.",
      talkingPoints: [
        "A defined cure period before termination-for-breach protects both sides from a hair-trigger termination over a fixable issue.",
        "If termination-for-convenience is off the table, a shorter initial term with renewal opt-outs achieves a similar flexibility.",
      ],
      escalation:
        "Escalate if the vendor can terminate for convenience with materially less notice than the customer receives, especially for a service the customer depends on operationally.",
    },
  },
  {
    issue: "Invoicing cadence, payment period, and late-payment consequences",
    severity: "medium",
    tiers: {
      acceptable: [
        "Invoices are payable within 30-45 days of receipt",
        "Late payment triggers a defined interest rate (capped at the statutory maximum) rather than an automatic right to suspend services",
      ],
      ideal:
        "Vendor will invoice Customer as set out in the applicable order, and Customer will pay undisputed amounts within thirty (30) days of receipt of a correct invoice. Amounts not paid when due accrue interest at the lesser of 1.5% per month or the maximum rate permitted by applicable law, and Vendor may not suspend services for non-payment without first giving Customer at least ten (10) days' written notice and an opportunity to cure.",
      fallback: [
        {
          label: "Suspension after notice and a cure period",
          text: "A right to suspend services for non-payment is acceptable provided the vendor gives written notice and a minimum 10-15 day cure period before suspending.",
        },
      ],
      notAcceptable: [
        "Payment due immediately or on receipt, with no standard payment period at all",
        "The vendor may suspend or terminate services immediately for late payment, with no notice or cure period",
      ],
    },
    negotiation: {
      rationale:
        "Payment terms are ordinary commercial mechanics, but an unqualified suspension right turns a billing dispute into an operational outage; the notice-and-cure period is what keeps a payment delay from becoming a service disruption.",
      talkingPoints: [
        "30 days is a common payment period; 45 days is reasonable for a larger enterprise customer with a longer AP cycle.",
        "A notice-and-cure period before suspension protects against outages caused by an administrative delay rather than a genuine payment dispute.",
      ],
      escalation:
        "Escalate any right for the vendor to suspend a production service immediately, with no notice, for late payment.",
    },
  },
  {
    issue: "Service-quality and non-infringement warranties",
    severity: "medium",
    tiers: {
      acceptable: [
        "The vendor warrants that services will be performed in a professional and workmanlike manner consistent with industry standards",
        "The vendor warrants that deliverables will not infringe third-party intellectual-property rights",
      ],
      ideal:
        "Vendor warrants that it will perform the services in a professional and workmanlike manner consistent with generally accepted industry standards, and that the deliverables, as provided, will not infringe any third party's intellectual property rights. If the services fail to conform to this warranty, Vendor will re-perform the non-conforming services at no additional cost.",
      fallback: [
        {
          label: "Re-performance as the sole remedy",
          text: "Limiting the customer's remedy for a warranty breach to re-performance of the non-conforming services, rather than damages, is acceptable provided the liability cap still applies if re-performance also fails.",
        },
      ],
      notAcceptable: [
        'Services and deliverables provided "as is" with all warranties disclaimed, including the implied warranty of workmanlike performance',
        "No warranty of non-infringement at all for vendor-provided deliverables",
      ],
    },
    negotiation: {
      rationale:
        "A blanket 'as is' disclaimer removes the customer's only contractual recourse for services that were simply performed badly, separate from any breach or IP claim.",
      talkingPoints: [
        "A basic professional-services warranty with a re-performance remedy is standard and low-cost for the vendor to give.",
        "Non-infringement warranties on deliverables are the natural complement to the IP-indemnity position elsewhere in the agreement.",
      ],
      escalation:
        "Escalate if the vendor disclaims all warranties, including basic workmanlike performance.",
    },
  },
  {
    issue:
      "Confidentiality obligations for information exchanged under the MSA",
    severity: "medium",
    tiers: {
      acceptable: [
        "Each party protects the other's confidential information with at least reasonable care, at least as protective as the care it uses for its own similarly sensitive information",
        "Confidentiality survives termination for a defined period (3-5 years), with trade secrets protected indefinitely",
      ],
      ideal:
        "Each party will protect the other party's Confidential Information using at least the same degree of care it uses to protect its own confidential information of similar importance, and in no event less than a reasonable degree of care. This Section survives termination of this Agreement for five (5) years, except that obligations relating to trade secrets survive for as long as the information qualifies as a trade secret under applicable law.",
      fallback: [
        {
          label: "Shorter survival aligned to a long initial term",
          text: "A two-year survival period is acceptable if the initial term itself is long (three years or more), provided trade secrets remain protected indefinitely.",
        },
      ],
      notAcceptable: [
        "No confidentiality protection at all for information exchanged during the engagement",
        "Confidentiality obligations end immediately at termination, with no survival period, including for trade secrets",
      ],
    },
    negotiation: {
      rationale:
        "An MSA often runs for years and involves ongoing exchange of pricing, roadmaps, and operational data; without a confidentiality clause of its own, that exchange has no contractual protection at all once the engagement is underway.",
      talkingPoints: [
        "A 3-5 year survival period is standard for ordinary business confidential information exchanged over the life of the engagement.",
        "Trade secrets should be carved out and protected indefinitely, consistent with how the underlying law already treats them.",
      ],
      escalation:
        "Escalate if the counterparty wants confidentiality obligations to lapse immediately at termination.",
    },
  },
];

export const STARTER_PLAYBOOKS: readonly StarterPlaybook[] = [
  {
    starterId: "nda",
    name: "Non-Disclosure Agreement",
    description:
      "Reviews an NDA for mutual obligations, a well-scoped definition of confidential information, and the standard protections around term, disclosure, and enforcement.",
    documentTypeKey: "nda",
    positions: buildStarterPositions(1, NDA_POSITIONS),
  },
  {
    starterId: "dpa",
    name: "Data Processing Agreement",
    description:
      "Reviews a DPA for clear controller/processor roles, sub-processor controls, security measures, breach notice timing, transfer mechanisms, audit rights, and end-of-relationship deletion.",
    documentTypeKey: "dpa",
    positions: buildStarterPositions(2, DPA_POSITIONS),
  },
  {
    starterId: "msa",
    name: "Master Services Agreement",
    description:
      "Reviews an MSA for a meaningful liability cap, fault-based indemnification, clear IP ownership, workable termination rights, standard payment terms, service warranties, and confidentiality.",
    documentTypeKey: "msa",
    positions: buildStarterPositions(3, MSA_POSITIONS),
  },
];

export const findStarterPlaybook = (
  starterId: string,
): StarterPlaybook | undefined =>
  STARTER_PLAYBOOKS.find((starter) => starter.starterId === starterId);
