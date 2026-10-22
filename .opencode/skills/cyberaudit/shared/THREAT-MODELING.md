# 🎯 THREAT MODELING — CYBERAUDIT SKILL
# Threat modeling framework for agents

═══════════════════════════════════════════════════════════════
               APPLIED STRIDE METHOD
═══════════════════════════════════════════════════════════════

STRIDE = 6 universal threat categories

S — SPOOFING (Identity spoofing)
  Question : "Can an attacker pretend to be someone else?"
  Web      : Auth bypass, forged JWT, session hijacking, phishing
  Mobile   : Spoofed certificate, fake app, deeplink hijacking
  Control : Strong authentication, certificate pinning, MFA

T — TAMPERING (Falsification)
  Question : "Can an attacker modify data?"
  Web      : SQLi, CSRF, mass assignment, man-in-the-middle
  Mobile   : Binary tampering, traffic interception, storage modification
  Control : Data integrity, signatures, HTTPS, validation

R — REPUDIATION (Non-repudiation)
  Question : "Can an attacker deny their actions?"
  Web      : Insufficient logs, missing audit trail
  Mobile   : No logging of sensitive actions
  Control : Complete logging, timestamp, action signing

I — INFORMATION DISCLOSURE (Information disclosure)
  Question : "Can an attacker access confidential data?"
  Web      : IDOR, error messages, source maps, exposed secrets
  Mobile   : Plaintext storage, sensitive logs, binary strings
  Control : Encryption, least privilege, output filtering

D — DENIAL OF SERVICE (Denial of service)
  Question : "Can an attacker make the service unavailable?"
  Web      : No rate limiting, expensive requests not limited
  Mobile   : Battery drain attacks, excessive network requests
  Control : Rate limiting, timeouts, circuit breakers

E — ELEVATION OF PRIVILEGE (Privilege escalation)
  Question : "Can an attacker obtain more rights?"
  Web      : BFLA, mass role assignment, IDOR on admin
  Mobile   : Jailbreak bypass, root privilege abuse
  Control : Strict RBAC, rights verification, least privilege

═══════════════════════════════════════════════════════════════
               ATTACK TREE BY APP TYPE
═══════════════════════════════════════════════════════════════

E-COMMERCE (Priorities)
  1. Payment bypass (business logic)
  2. Credit card data theft
  3. Account takeover → fraudulent purchase
  4. Price manipulation
  5. Personal data theft (GDPR)

SaaS B2B (Priorities)
  1. Access to other tenants' data (isolation)
  2. Admin account takeover
  3. Mass data export
  4. API abuse / scraping
  5. Privilege escalation between plans

HEALTH / FINANCE APP (Priorities)
  1. Access to others' medical/financial data
  2. Modification of critical data
  3. Credential compromise
  4. Regulatory non-compliance (HIPAA, PCI-DSS)
  5. Insufficient logging for legal audit

FINANCIAL MOBILE APP (Priorities)
  1. Token/session theft on compromised device
  2. Transaction interception (MitM)
  3. Amount manipulation
  4. Screenshot / recording of sensitive data
  5. Root/jailbreak bypass of protections

═══════════════════════════════════════════════════════════════
               COMMON KILL CHAINS
═══════════════════════════════════════════════════════════════

KILL CHAIN 1 — ACCOUNT TAKEOVER VIA RESET PASSWORD
  1. Account enumeration via /forgot-password
     (different message depending on whether email exists)
  2. Predictable reset token or no expiration
  3. Token intercepted or brute forced
  4. Account compromised → access to all data

KILL CHAIN 2 — DATA BREACH VIA CHAINED IDOR
  1. Discovery of an endpoint with sequential ID
     GET /api/orders/1234
  2. Enumeration : 1234, 1235, 1236...
  3. Extraction of all orders/data
  4. Personal data of all users exposed

KILL CHAIN 3 — RCE VIA FILE UPLOAD + PATH TRAVERSAL
  1. Upload a .php file disguised as .jpg
     (MIME type spoofed)
  2. File stored in a web-accessible directory
  3. Direct access to the uploaded file
  4. PHP code execution → shell → RCE

KILL CHAIN 4 — MOBILE DATA BREACH VIA BACKUP
  1. Android app without backup restrictions
     android:allowBackup="true"
  2. ADB backup extracted without root required
  3. AsyncStorage/SharedPreferences read in plaintext
  4. Authentication tokens extracted
  5. Session hijacking on any device

These kill chains must be documented when the exploitation
conditions are met in the audited code.
