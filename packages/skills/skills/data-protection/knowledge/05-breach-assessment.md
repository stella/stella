## Breach assessment

A personal data breach is a security incident leading to the
accidental or unlawful destruction, loss, alteration,
unauthorised disclosure of, or access to personal data
(Art 4(12)). The EDPB's Guidelines 9/2022 on personal data
breach notification, its predecessor (WP250 rev.01), and the
EDPB Guidelines 01/2021 on breach notification examples provide
the assessment methodology. Common breach scenarios include
ransomware attacks, data exfiltration, lost or stolen devices,
misdirected communications (misposting), and social engineering
attacks.

### Breach classification

Breaches are classified by the type of compromise:

| Type            | Definition                                                                     | Examples                                                                                 |
| --------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Confidentiality | Unauthorised or accidental disclosure of, or access to, personal data          | Misdirected email, unauthorised database access, stolen unencrypted device               |
| Integrity       | Unauthorised or accidental alteration of personal data                         | Database corruption, ransomware encryption, unauthorised record modification             |
| Availability    | Accidental or unauthorised loss of access to, or destruction of, personal data | Ransomware (also integrity), accidental deletion without backup, prolonged system outage |

A single incident may involve multiple types simultaneously
(e.g., ransomware typically affects both integrity and
availability; if data is exfiltrated, confidentiality as well).

### Severity assessment

The risk to data subjects is assessed based on:

1. **Type and sensitivity of personal data**: special category
   data (Art 9), financial data, identification documents, and
   communications data carry higher risk. Volume amplifies
   severity.
2. **Ease of identification**: data that directly identifies
   individuals (names, ID numbers) poses greater risk than
   pseudonymised data requiring additional information to
   re-identify.
3. **Severity of consequences**: consider discrimination, identity
   theft or fraud, financial loss, damage to reputation, loss of
   confidentiality of data protected by professional secrecy,
   and any other significant economic or social disadvantage.
4. **Special characteristics of data subjects**: children,
   employees, patients, and other vulnerable individuals warrant
   heightened concern.
5. **Number of individuals affected**: larger scale increases
   overall risk, though even a single individual can face high
   risk depending on the data involved.
6. **Special characteristics of the controller**: the nature and
   role of the controller (e.g., medical professional, financial
   institution) may amplify the consequences.

### Risk thresholds and notification obligations

The GDPR establishes three tiers of response based on the risk
level:

| Risk level                       | SA notification (Art 33)   | Data subject notification (Art 34) | Documentation (Art 33(5)) |
| -------------------------------- | -------------------------- | ---------------------------------- | ------------------------- |
| Unlikely to result in a risk     | Not required               | Not required                       | Required                  |
| Risk to rights and freedoms      | Required (within 72 hours) | Not required                       | Required                  |
| High risk to rights and freedoms | Required (within 72 hours) | Required (without undue delay)     | Required                  |

#### Article 33: supervisory authority notification

- **Deadline**: without undue delay and, where feasible, within
  72 hours of becoming aware. If notification is made after
  72 hours, the controller must provide reasons for the delay.
- **Awareness**: the controller is "aware" when it has a
  reasonable degree of certainty that a security incident has
  occurred that has led to personal data being compromised
  (EDPB Guidelines 9/2022, para 40). The threshold is a
  "reasonable conclusion that it is likely" a breach occurred,
  not absolute certainty (ICO Marriott decision). A controller
  cannot delay the clock by prolonging its investigation.
- **Required content** (Art 33(3)): nature of the breach
  (categories and approximate number of data subjects and
  records); DPO or other contact point; likely consequences;
  measures taken or proposed to address the breach and mitigate
  adverse effects.
- **Phased notification**: where full information is not available
  within 72 hours, Art 33(4) permits information to be provided
  in phases without undue further delay.

#### Article 34: data subject notification

- **Trigger**: the breach is likely to result in a high risk to
  the rights and freedoms of natural persons.
- **Content**: clear and plain language description of the nature
  of the breach; DPO or other contact point; likely consequences;
  measures taken or proposed.
- **Exceptions** (Art 34(3)): notification is not required if
  the controller has (a) implemented appropriate prior
  safeguards that render the data unintelligible (e.g.,
  encryption where the key is not compromised); (b) taken
  subsequent measures ensuring the high risk is no longer likely
  to materialise; or (c) notification would involve
  disproportionate effort, in which case a public communication
  is required instead.

### Breach response method

1. **Contain**: take immediate steps to stop the breach and
   limit its scope (isolate affected systems, revoke
   compromised credentials, recover data if possible).
2. **Assess**: determine what data was affected, how many
   individuals are impacted, and what type of breach occurred
   (confidentiality, integrity, availability, or combination).
3. **Classify**: apply the severity factors above to determine
   the risk level (no risk, risk, or high risk).
4. **Notify**: based on the risk classification, determine
   whether SA notification (Art 33) and data subject
   notification (Art 34) are required. Identify the competent
   SA under the one-stop-shop mechanism (Art 56) if applicable.
5. **Document**: record the facts of the breach, its effects,
   and the remedial action taken (Art 33(5)). This obligation
   applies regardless of whether the breach is notifiable.
6. **Remediate**: implement measures to prevent recurrence;
   review whether the incident reveals systemic weaknesses in
   the controller's technical and organisational measures
   (Art 32).

### Common assessment errors

- Treating availability breaches as non-notifiable: a prolonged
  inability to access personal data (e.g., hospital patient
  records during a ransomware attack) can pose a high risk
  even without data exfiltration.
- Starting the 72-hour clock from the conclusion of an
  investigation rather than from initial awareness: the clock
  starts when the controller has a reasonable degree of
  certainty, not when the investigation is complete.
- Failing to account for encryption quality: encryption only
  mitigates risk under Art 34(3)(a) if the encryption standard
  was robust at the time of the breach and the key was not
  compromised.
- Assessing risk to the controller (reputational, financial)
  rather than risk to data subjects: the notification
  thresholds focus exclusively on risk to the individuals
  whose data was breached.
- Inadequate breach documentation: the Art 33(5) obligation to
  maintain a breach register applies to all breaches, including
  those assessed as unlikely to result in a risk. Enforcement
  actions have targeted documentation failures specifically
  (DPC Twitter decision).
