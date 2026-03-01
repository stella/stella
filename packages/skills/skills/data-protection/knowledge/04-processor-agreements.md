## Processor agreements

Article 28 requires that processing by a processor be governed
by a contract or other legal act that is binding on the
processor. The EDPB's Guidelines 07/2020 on controller and
processor concepts provide detailed guidance on the functional
determination and the substantive requirements. When selecting
a processor, the controller must verify "sufficient guarantees"
(Art 28(1)); relevant factors include the processor's expert
knowledge, reliability, resources, adherence to codes of
conduct or certification, and reputation (EDPB Guidelines
07/2020).

### Functional role determination

Before reviewing a data processing agreement (DPA), assess
whether the parties' actual roles match their contractual
designations. The test is functional, not formal
(_Wirtschaftsakademie_, C-210/16; _Fashion ID_, C-40/17):

- Who determines the **purposes** of processing (the "why")?
- Who determines the **essential means** (type of data, duration,
  categories of data subjects, operations performed)?
- Who determines only the **non-essential means** (technical
  implementation, security measures, IT infrastructure)?

The entity that determines purposes and essential means is the
controller; the entity that determines only non-essential means
while acting on instructions is the processor. If both parties
determine purposes and essential means, they are joint
controllers under Art 26.

### Article 28(3) mandatory elements

The DPA must set out the following. Use this as an assessment
checklist:

| Element                             | Article  | What to verify                                                                                                                                                            |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject-matter and duration         | 28(3)    | Matches the actual processing; duration aligned with the service term                                                                                                     |
| Nature and purpose of processing    | 28(3)    | Specific enough to constrain the processor; not a blanket authorisation                                                                                                   |
| Types of personal data              | 28(3)    | Exhaustive list; includes special category data if applicable                                                                                                             |
| Categories of data subjects         | 28(3)    | All affected groups identified                                                                                                                                            |
| Controller's obligations and rights | 28(3)    | Instruction rights, audit rights, and the controller's compliance obligations                                                                                             |
| Processing only on instructions     | 28(3)(a) | Including EU/member state law exceptions; the processor must inform the controller before processing under a legal obligation                                             |
| Confidentiality                     | 28(3)(b) | Persons authorised to process must be bound by confidentiality obligations                                                                                                |
| Security measures                   | 28(3)(c) | Reference to Art 32; specific technical and organisational measures identified                                                                                            |
| Sub-processor governance            | 28(3)(d) | General or specific authorisation; obligation to impose equivalent obligations on sub-processors                                                                          |
| Data subject rights assistance      | 28(3)(e) | Processor assists the controller in responding to data subject requests                                                                                                   |
| Compliance assistance               | 28(3)(f) | Assistance with Arts 32-36 (security, breach notification, DPIAs, prior consultation)                                                                                     |
| Data return or deletion             | 28(3)(g) | At the end of the service, personal data is returned or deleted at the controller's choice; processor deletes existing copies unless EU/member state law requires storage |
| Audit and inspection                | 28(3)(h) | Processor makes available all information necessary to demonstrate compliance; allows and contributes to audits                                                           |

### Sub-processor chain analysis

Article 28(2) and (4) govern sub-processing:

- **General authorisation**: the controller grants prior general
  written authorisation for sub-processors; the processor must
  inform the controller of any intended changes (additions or
  replacements), giving the controller the opportunity to object.
  Under the EDPB's interpretation, silence in response to a
  general authorisation notification is treated as consent.
- **Specific authorisation**: each sub-processor requires
  individual prior written authorisation. Silence in response
  to a specific authorisation request is treated as refusal.
- **Flow-down obligation**: the processor must impose the same
  data protection obligations on sub-processors by contract
  (Art 28(4)). The "same obligations" requirement is functional,
  not formal: the sub-processor contract must achieve equivalent
  protection, though it need not replicate the wording verbatim
  (EDPB Guidelines 07/2020). If the sub-processor fails to
  fulfil its obligations, the initial processor remains fully
  liable to the controller.

#### Verification points

- Is the authorisation mechanism (general or specific) clearly
  stated?
- Does the controller have a meaningful right to object to new
  sub-processors (not merely a right to terminate after the fact)?
- Are current sub-processors listed, including their location
  and processing activities?
- Do sub-processor contracts impose equivalent obligations?

### International transfer provisions

Where the processor or its sub-processors are located outside
the EEA, the DPA must address Chapter V requirements:

- Identify the transfer mechanism (adequacy decision, SCCs,
  BCRs, or a derogation under Art 49).
- Post-_Schrems II_ (C-311/18): where SCCs are the mechanism,
  assess whether supplementary measures are necessary to ensure
  an essentially equivalent level of protection.
- Verify that the DPA does not undermine the transfer mechanism
  (e.g., a DPA that grants the processor discretion to transfer
  data to any jurisdiction contradicts the specificity required
  by SCCs).

### Red flags in DPA review

- **Circular instructions**: DPA states the processor acts on
  the controller's instructions, but the service terms grant
  the processor broad discretion to determine processing
  purposes (suggesting actual controller or joint controller
  status). A processor that goes beyond the controller's
  instructions becomes a de facto controller for that
  processing (Art 28(10); EDPS Microsoft investigation).
- **Unexercisable audit rights**: audit clause is present but
  hedged with conditions that make exercise impractical
  (excessive notice periods, "commercially reasonable" limits
  on scope, audit costs borne entirely by the controller).
- **Missing breach notification timeline**: Art 28(3)(f)
  requires the processor to notify the controller "without
  undue delay" after becoming aware of a breach. DPAs that omit
  a specific timeline or state "within 72 hours" (conflating
  the processor's obligation with the controller's Art 33
  deadline) create ambiguity.
- **Deletion at discretion**: data return/deletion clause
  permits the processor to retain data for unspecified
  "legitimate business purposes" after service termination.
- **Inadequate sub-processor controls**: general authorisation
  without a meaningful objection mechanism or without a current
  sub-processor list.
- **Missing liability allocation**: the DPA does not address
  allocation of liability between controller and processor
  under Art 82.

### DPA review method

1. Assess the functional roles of the parties.
2. Check each Art 28(3) mandatory element against the DPA text.
3. Evaluate the sub-processor governance mechanism.
4. Review international transfer provisions if applicable.
5. Identify red flags and assess their severity.
6. Provide an overall compliance assessment, noting which gaps
   are mandatory-element failures (high severity) versus
   best-practice shortfalls (medium severity).
