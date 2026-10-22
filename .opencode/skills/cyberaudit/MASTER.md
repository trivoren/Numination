# CYBERAUDIT MASTER INTELLIGENCE
# The brain file — Loaded permanently

═══════════════════════════════════════════════════════════════
              AUDIT MENTAL ARCHITECTURE
═══════════════════════════════════════════════════════════════

UNIVERSAL PRINCIPLE N°1 — THE ATTACK SURFACE IS EVERYWHERE
──────────────────────────────────────────────────────────
  Everything that receives data = attack surface
  Everything that sends data = leak surface
  Everything that makes decisions = bypass surface
  Everything that stores data = exposure surface

UNIVERSAL PRINCIPLE N°2 — SECURITY IS AN EMERGENT PROPERTY
──────────────────────────────────────────────────────────
  Security is not a feature you add.
  It is a property that emerges from every architectural
  decision, every line of code, every config.

  A secure app = 10,000 correct micro-decisions.
  A compromised app = 1 incorrect micro-decision.

UNIVERSAL PRINCIPLE N°3 — THE ATTACKER HAS TIME
─────────────────────────────────────────────────
  The developer has deadlines.
  The attacker has eternity.

  What will "probably never happen"
  will happen as soon as the app has value.

UNIVERSAL PRINCIPLE N°4 — THE CHAIN OF TRUST
───────────────────────────────────────────────
  Always trace the full chain:

  INPUT → VALIDATION → PROCESSING → STORAGE → OUTPUT
    ↑                                            ↑
  Where are the flaws?               Where does data leak?

UNIVERSAL PRINCIPLE N°5 — THE CIA MODEL
────────────────────────────────────────
  Every finding must impact at least one pillar:

  C — Confidentiality  (who can read what?)
  I — Integrity        (who can modify what?)
  A — Availability     (who can disrupt service?)

  + Authentication    (is it really you?)
  + Authorization     (do you have permission?)
  + Non-repudiation   (can we prove who did what?)

═══════════════════════════════════════════════════════════════
              VULNERABILITY TAXONOMY
═══════════════════════════════════════════════════════════════

CATEGORY A — INJECTION (Hostile input → Execution)
  A1. SQL Injection          → Database compromised
  A2. NoSQL Injection        → MongoDB, Redis manipulated
  A3. Command Injection      → OS compromised
  A4. LDAP Injection         → Directory compromised
  A5. XPath Injection        → XML data compromise
  A6. SSTI                   → Template engine hijacked
  A7. GraphQL Injection      → Graph API manipulated
  A8. ORM Injection          → Bypassed abstraction
  A9. Log Injection          → SIEM corrupted

CATEGORY B — AUTHENTICATION (Identity compromised)
  B1. Brute Force            → Account compromised by force
  B2. Credential Stuffing    → Password reuse
  B3. Session Fixation       → Session hijacking
  B4. JWT Attacks            → Forged or stolen token
  B5. OAuth Flaws            → Authorization code stolen
  B6. Password Reset Flaws   → Account takeover
  B7. MFA Bypass             → 2FA bypassed
  B8. Default Credentials    → Admin/admin in production
  B9. Auth Bypass            → Logic flaw in auth

CATEGORY C — AUTHORIZATION (Rights not enforced)
  C1. IDOR/BOLA              → Access to others' data
  C2. BFLA                   → Admin functions without rights
  C3. Privilege Escalation   → User → Admin
  C4. Path Traversal         → Files outside scope
  C5. RBAC Bypass            → Roles bypassed
  C6. Mass Assignment        → Unauthorized fields modified
  C7. JWT Role Manipulation  → Elevation via modified token

CATEGORY D — DATA EXPOSURE (Leak)
  D1. Hardcoded Secrets      → API keys in code
  D2. Sensitive Data in Logs → PII in logs
  D3. Error Messages         → Stack traces in production
  D4. API Over-fetching      → Too much data returned
  D5. Backup Files Exposed   → .sql, .bak accessible
  D6. Source Maps in Prod    → Source code reconstructed
  D7. Debug Endpoints        → /debug, /phpinfo in production
  D8. Git History            → Secrets in history
  D9. Directory Listing      → Structure exposed

CATEGORY E — CONFIGURATION (Bad setup)
  E1. CORS Misconfiguration  → Cross-origin abuse
  E2. Missing Security Headers → CSP, HSTS, X-Frame missing
  E3. TLS/SSL Issues         → Weak encryption
  E4. CSRF Missing           → Forged actions
  E5. Clickjacking           → UI hijacking
  E6. Debug Mode in Prod     → Massive exposure
  E7. Default Config         → Factory config in production
  E8. Open Redirect          → Phishing enabled
  E9. SSRF                   → Internal infrastructure exposed

CATEGORY F — DEPENDENCIES (Supply Chain)
  F1. CVE in dependencies    → Known vulnerabilities
  F2. Outdated Packages      → Missed security patches
  F3. Typosquatting          → Malicious package installed
  F4. Dependency Confusion   → Internal package spoofed
  F5. Malicious Package      → Backdoor in dependency
  F6. License Issues         → Legal/compliance risk

CATEGORY G — BUSINESS LOGIC (Logic Flaws)
  G1. Race Conditions        → Double spend, double action
  G2. Price Manipulation     → Bypassing prices
  G3. Workflow Bypass        → Skipped steps
  G4. Rate Limiting Missing  → Feature abuse
  G5. Business Logic Abuse   → Unintended use
  G6. Time-of-check/Time-of-use → TOCTOU attacks
  G7. Negative Values        → Unexpected input

═══════════════════════════════════════════════════════════════
              SCORING AND PRIORITIZATION
═══════════════════════════════════════════════════════════════

SEVERITY MATRIX
────────────────────

  CRITICAL (Score 9.0-10.0)
  ┌────────────────────────────────────────────────────────┐
  │ Immediate exploitation with no prerequisites           │
  │ Full impact on confidentiality/integrity/availability  │
  │ No user interaction required                           │
  │ Data of all users compromised                          │
  │                                                        │
  │ EXAMPLE: Unauthenticated SQLi on public endpoint       │
  │ ACTION   : Block deployment. Fix NOW                   │
  └────────────────────────────────────────────────────────┘

  HIGH (Score 7.0-8.9)
  ┌────────────────────────────────────────────────────────┐
  │ Exploitation possible with few prerequisites           │
  │ Significant impact on C, I, or A                       │
  │ Data of one user or group compromised                  │
  │                                                        │
  │ EXAMPLE: IDOR on user profile                          │
  │ ACTION   : Fix before next deployment                  │
  └────────────────────────────────────────────────────────┘

  MEDIUM (Score 4.0-6.9)
  ┌────────────────────────────────────────────────────────┐
  │ Exploitation requires specific conditions              │
  │ Partial or limited impact                              │
  │ Combinable with other flaws for amplification          │
  │                                                        │
  │ EXAMPLE: CSRF on non-critical action                   │
  │ ACTION   : Schedule in next sprint                     │
  └────────────────────────────────────────────────────────┘

  LOW (Score 0.1-3.9)
  ┌────────────────────────────────────────────────────────┐
  │ Minimal impact, complex exploitation                   │
  │ General security posture improvement                   │
  │                                                        │
  │ EXAMPLE: Missing X-Content-Type-Options header          │
  │ ACTION   : Security backlog, fix in batch              │
  └────────────────────────────────────────────────────────┘

  INFO (Score 0.0)
  ┌────────────────────────────────────────────────────────┐
  │ No direct risk but important observation               │
  │ Best practice not followed                             │
  │ Attention point for future architecture                │
  │                                                        │
  │ EXAMPLE: Missing audit logging                         │
  │ ACTION   : Documented recommendation                   │
  └────────────────────────────────────────────────────────┘

AGGRAVATING FACTORS (increase severity)
  + Application exposed on public Internet          → +1 level
  + PII/financial/health data involved              → +1 level
  + No defense layer upstream                       → +0.5 level
  + Exploitation already publicly documented (PoC)  → +1 level
  + Flaw in auth/payment component                  → +1 level

MITIGATING FACTORS (decrease severity)
  - Authenticated access required to exploit        → -1 level
  - WAF or other protection layer active            → -0.5 level
  - Internal network access only                    → -1 level
  - Impact limited to non-sensitive data            → -0.5 level
