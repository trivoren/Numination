# ⚖️ COMPLIANCE — CYBERAUDIT SKILL
# Regulatory compliance guide for auditing

═══════════════════════════════════════════════════════════════
  USAGE : This file guides the agent to assess regulatory
  compliance during the audit. Loaded automatically
  when sensitive data is detected or requested
  explicitly.
═══════════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════════
               GDPR — GENERAL DATA PROTECTION REGULATION
═══════════════════════════════════════════════════════════════

APPLICABILITY
─────────────
  Applies if :
  → The application processes data of EU residents
  → Regardless of the company's hosting country
  → Personal data = any info identifying a person

  Personal data concerned :
  → First name, last name, email, phone
  → IP address (considered personal data)
  → Location data
  → Online identifiers (cookies, device ID)
  → Health data (special category — enhanced protection)
  → Biometric data (special category)
  → Financial / banking data

GDPR TECHNICAL REQUIREMENTS
──────────────────────────

  ARTICLE 25 — Privacy by Design & by Default
  ┌──────────────────────────────────────────────────────────┐
  │ CHECK :                                                  │
  │ □ Minimal collection (only what is necessary)           │
  │ □ Defined and enforced retention period                 │
  │ □ Unnecessary data automatically deleted                 │
  │ □ Pseudonymization of data when possible                │
  │ □ Encryption of personal data at rest                    │
  │ □ Encryption in transit (HTTPS)                         │
  │ □ Access to personal data logged                        │
  │ □ Restrictive privacy settings by default               │
  └──────────────────────────────────────────────────────────┘

  ARTICLE 32 — Security of processing
  ┌──────────────────────────────────────────────────────────┐
  │ CHECK :                                                  │
  │ □ Encryption of personal data                           │
  │ □ Confidentiality, integrity, availability ensured      │
  │ □ Ability to restore after an incident                   │
  │ □ Regular testing and evaluation procedure              │
  │ □ Password hashing (bcrypt/argon2)                      │
  │ □ Strong authentication for PII data access             │
  │ □ RBAC limiting access to personal data                 │
  └──────────────────────────────────────────────────────────┘

  ARTICLE 33 — Breach notification
  ┌──────────────────────────────────────────────────────────┐
  │ CHECK :                                                  │
  │ □ Logging of PII data access and modifications          │
  │ □ Ability to detect a breach (monitoring)               │
  │ □ Ability to identify compromised data                  │
  │ □ Documented notification procedure (72h)               │
  └──────────────────────────────────────────────────────────┘

  USER RIGHTS — Technical requirements
  ┌──────────────────────────────────────────────────────────┐
  │ Right of access (Art. 15)                                │
  │   □ User data export available                          │
  │   □ Readable format (JSON, CSV)                         │
  │                                                          │
  │ Right to erasure (Art. 17)                               │
  │   □ Effective deletion (not just deactivation)          │
  │   □ Cascade deletion (all tables)                       │
  │   □ Deletion in backups (policy)                        │
  │                                                          │
  │ Right to data portability (Art. 20)                     │
  │   □ Export in an interoperable format                   │
  │                                                          │
  │ Right to rectification (Art. 16)                        │
  │   □ Modification of personal data possible              │
  └──────────────────────────────────────────────────────────┘

COMMON GDPR FINDINGS TO DETECT
───────────────────────────────────

  CRITICAL — Personal data in plaintext in database
    Pattern : Unencrypted columns for : ssn, passport,
              health_data, payment_method, biometric_data
    Severity : HIGH (GDPR special categories = CRITICAL)
    Remediation : AES-256 encryption at application level
                  or transparent database encryption

  CRITICAL — No retention period
    Pattern : No cron/job for automatic deletion,
              data kept indefinitely
    Severity : MEDIUM
    Remediation : Implement a retention policy
                  with automatic deletion

  HIGH — Logs containing personal data
    Pattern : console.log(user), logger.info({email, name}),
              requests logged with body containing PII
    Severity : HIGH
    Remediation : Mask/pseudonymize in logs

  HIGH — No right to erasure
    Pattern : No DELETE /user/account route,
              soft delete only
    Severity : MEDIUM
    Remediation : Implement full deletion

  MEDIUM — Cookies without consent
    Pattern : Analytics/tracking cookies without banner,
              persistent non-essential cookies
    Severity : MEDIUM
    Remediation : Implement a CMP (Consent Management)

═══════════════════════════════════════════════════════════════
               PCI-DSS — PAYMENT CARD INDUSTRY DATA SECURITY STANDARD
═══════════════════════════════════════════════════════════════

APPLICABILITY
─────────────
  Applies if :
  → The application processes, stores, or transmits card data
  → Card numbers, CVV, expiration dates, PIN
  → EVEN if using Stripe/PayPal (reduced scope
    but minimum requirements still apply)

GOLDEN RULE OF PCI-DSS FOR DEVELOPERS
──────────────────────────────────────────

  NEVER STORE :
  → CVV/CVC (security code) — ABSOLUTELY FORBIDDEN
  → Card number in plaintext
  → PIN in plaintext
  → Full magnetic stripe data

  If using Stripe/PayPal (recommended) :
  → Never see card data on server side
  → Use Stripe tokens (tok_xxx, pm_xxx) only
  → Validated webhook signature

COMMON PCI-DSS FINDINGS
──────────────────────────

  CRITICAL — Storing the CVV
    Pattern : cvv column, card_security_code in database
              Log containing a CVV
    Severity : CRITICAL — direct PCI-DSS violation
    Remediation : Immediate deletion, never store

  CRITICAL — Card number in plaintext
    Pattern : card_number, pan, credit_card column not tokenized
    Severity : CRITICAL
    Remediation : Tokenization via Stripe/Braintree,
                  or encryption + masking (1234 **** **** 5678)

  HIGH — Stripe webhook without signature validation
    Pattern : app.post('/webhook/stripe', (req, res) => {
                const event = req.body // No verification !
    Severity : HIGH
    Remediation :
      const event = stripe.webhooks.constructEvent(
        req.rawBody,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      )

  HIGH — Stripe Live key in plaintext in code
    Pattern : sk_live_xxxxxxxx in source code
    Severity : CRITICAL (exposed secret)
    Remediation : Environment variable immediately,
                  rotate the compromised key

  MEDIUM — Logs with card numbers (even partial)
    Pattern : logger.info('Payment for card:', cardNumber)
    Severity : HIGH
    Remediation : Never log card data

═══════════════════════════════════════════════════════════════
               HIPAA — HEALTH INSURANCE PORTABILITY AND ACCOUNTABILITY ACT
═══════════════════════════════════════════════════════════════

APPLICABILITY
─────────────
  Applies if :
  → US application processing PHI (Protected Health Information)
  → Health data : diagnoses, prescriptions, results,
    medical records, health insurance data

HIPAA TECHNICAL REQUIREMENTS (SAFEGUARDS)
─────────────────────────────────────────

  □ Encryption of PHI at rest (AES-256 minimum)
  □ Encryption of PHI in transit (TLS 1.2+)
  □ Unique user access control
  □ Audit logs of all PHI accesses
  □ Automatic logout after inactivity
  □ Strong authentication mandatory
  □ Mobile device encryption
  □ Documented breach procedure (60 days notification)

COMMON HIPAA FINDINGS
────────────────────────

  CRITICAL — PHI not encrypted in database
    Fields : diagnosis, prescription, medical_record,
             health_condition, lab_results
    Remediation : AES-256 encryption at application level

  CRITICAL — PHI in logs
    Pattern : logger.debug('Patient data:', patient)
    Remediation : Never log PHI

  HIGH — No audit trail for PHI accesses
    Pattern : No logging of PHI reads/modifications
    Remediation : Log each access with user_id, timestamp,
                  action, resource_id

  HIGH — Session without timeout
    Pattern : No inactive session expiration
    Remediation : 15 minute inactivity timeout for PHI

═══════════════════════════════════════════════════════════════
               SOC 2 — SERVICE ORGANIZATION CONTROL 2
═══════════════════════════════════════════════════════════════

APPLICABILITY
─────────────
  Often required by B2B Enterprise customers
  Especially in SaaS, cloud services

RELEVANT TRUST SERVICE CRITERIA
───────────────────────────────────

  CC6 — Logical and Physical Access Controls
  □ MFA on all admin access
  □ Principle of least privilege
  □ Quarterly access review
  □ Immediate revocation upon departure

  CC7 — System Operations
  □ Anomaly monitoring
  □ Intrusion detection
  □ Alerts on security events

  CC8 — Change Management
  □ Security tests in CI/CD pipeline
  □ Code review before merge
  □ Audit trail of changes

  CC9 — Risk Mitigation
  □ Third-party vendor management
  □ Dependency audit
  □ Incident management procedure

═══════════════════════════════════════════════════════════════
               COMPLIANCE CHECKLIST FOR THE AGENT
═══════════════════════════════════════════════════════════════

AUTOMATIC COMPLIANCE CONTEXT DETECTION
─────────────────────────────────────────────

  If the app contains these patterns → enable GDPR :
  → Columns : email, name, phone, address, ip_address,
              birth_date, gender, nationality
  → Routes : /register, /profile, /user
  → Mentions : gdpr, rgpd, dpo, privacy

  If the app contains these patterns → enable PCI-DSS :
  → Columns : card_number, cvv, expiry, pan
  → Imports : stripe, braintree, paypal, square
  → Routes : /payment, /checkout, /billing

  If the app contains these patterns → enable HIPAA :
  → Columns : diagnosis, prescription, medical, health,
              patient, ehr, emr
  → Imports : hl7, fhir
  → Context mentioned in the code/README

COMPLIANCE SCORING
───────────────────

  COMPLIANT     : All applicable requirements met
  PARTIAL       : >70% of requirements met
  NON-COMPLIANT : <70% of requirements met
  CRITICAL      : Direct violation of a mandatory rule
                  (e.g.: CVV stored = direct PCI-DSS violation)

LEGAL NOTICE
────────────────────

  This compliance guide is provided for informational purposes
  to guide the technical audit. It does not constitute
  legal advice. For official certification,
  consult a certified auditor (QSA for PCI-DSS,
  DPO for GDPR, HIPAA Privacy Officer for HIPAA).

  Official references :
  → GDPR    : https://gdpr.eu/
  → PCI-DSS : https://www.pcisecuritystandards.org/
  → HIPAA   : https://www.hhs.gov/hipaa/
  → SOC 2   : https://www.aicpa.org/
