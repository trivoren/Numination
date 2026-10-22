# 🛡️ SECURITY AUDIT REPORT — WEB APPLICATION
# Official CyberAudit Skill Template

═══════════════════════════════════════════════════════════════
              REPORT HEADER
═══════════════════════════════════════════════════════════════

SECURITY AUDIT REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Application     : [APPLICATION NAME]
Version         : [VERSION]
Framework(s)    : [FRAMEWORK(S) AUDITED]
Audit type      : Web Application Security Audit
Audit level     : [Quick Scan / Standard / Deep / Red Team]
Date            : [DATE]
Auditor         : CyberAudit Intelligence v3.1.5
Confidentiality : 🔴 CONFIDENTIAL — Internal use only

═══════════════════════════════════════════════════════════════
              EXECUTIVE SUMMARY
═══════════════════════════════════════════════════════════════

OVERALL VERDICT: [🔴 CRITICAL / 🟠 HIGH / 🟡 MODERATE / 🟢 ACCEPTABLE]

SECURITY SCORE: [XX]/100

  [████████░░░░░░░░░░░░] [XX]%
  
  0-20  : 🔴 Critical — Do not deploy
  21-40 : 🟠 High — Major fixes required
  41-60 : 🟡 Moderate — Significant fixes before prod
  61-80 : 🟢 Good — Some fixes recommended
  81-100: ✅ Excellent — Ready for production

VULNERABILITY DASHBOARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  🔴 CRITICAL : [N] vulnerability(ies)  → Block deployment
  🟠 HIGH     : [N] vulnerability(ies)  → Fix before deployment
  🟡 MEDIUM   : [N] vulnerability(ies)  → Fix within 30 days
  🟢 LOW      : [N] vulnerability(ies)  → Security backlog
  ℹ️  INFO     : [N] observation(s)     → Recommendations

  TOTAL : [N] findings

IDENTIFIED BUSINESS RISKS
━━━━━━━━━━━━━━━━━━━━━━━━━━
  → [Risk 1 in business language, not technical]
  → [Risk 2: impact on users/data]
  → [Risk 3: legal/compliance risk if applicable]

IMMEDIATE ACTIONS REQUIRED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  1. [Critical action 1 — affected file/module]
  2. [Critical action 2]
  3. [Critical action 3]

═══════════════════════════════════════════════════════════════
              AUDIT SCOPE
═══════════════════════════════════════════════════════════════

INCLUDED IN AUDIT:
  ✅ [Module/Component 1]
  ✅ [Module/Component 2]
  ✅ [Module/Component 3]

OUT OF SCOPE:
  ⭕ [Item not audited 1 — reason]
  ⭕ [Item not audited 2 — reason]

ASSUMPTIONS AND LIMITATIONS:
  → [Assumption 1: source code only, no dynamic testing]
  → [Limitation 1: static audit, some execution paths not tested]

═══════════════════════════════════════════════════════════════
              DETAILED FINDINGS
═══════════════════════════════════════════════════════════════

Agent instruction: For each finding, use this exact format.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[VULN-WEB-001] — [VULNERABILITY TITLE]
─────────────────────────────────────────────

  Severity      : 🔴 CRITICAL
  CVSS Score    : [X.X] (CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H)
  Category      : [Injection / Auth / XSS / etc.]
  OWASP         : [A03:2021 — Injection]
  CWE           : [CWE-89 — SQL Injection]
  
  File(s)       : [path/to/file.ext]
  Line(s)       : [N-M]
  
  ┌─ VULNERABLE CODE ─────────────────────────────────────────┐
  │                                                            │
  │  [Exact code showing the vulnerability]                   │
  │  [Annotated to show the precise problem]                 │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
  
  DESCRIPTION
  ───────────
  [Clear and precise explanation of the vulnerability.
  What happens, why it's a problem.
  2-4 sentences maximum.]
  
  IMPACT
  ──────
  [Technical AND concrete business impact.
  What can an attacker do?
  What data/functions are compromised?
  What is the impact on users?]
  
  PROOF OF CONCEPT (if applicable)
  ──────────────────────────────────
  [Demonstration of exploitability without going
  all the way to a full exploit. Example payload.]
  
  ┌─ FIXED CODE ──────────────────────────────────────────────┐
  │                                                            │
  │  [Complete fixed code]                                    │
  │  [Comments explaining each protection]                   │
  │  [Ready to copy-paste]                                    │
  │                                                            │
  └────────────────────────────────────────────────────────────┘
  
  ADDITIONAL REMEDIATION
  ──────────────────────────
  → [Additional step 1 if applicable]
  → [System configuration to modify]
  → [Test to add to prevent regression]
  
  REFERENCES
  ──────────
  → [Relevant OWASP link]
  → [CWE link]
  → [Framework documentation]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Repeat for each finding, grouped by severity]

═══════════════════════════════════════════════════════════════
              OWASP TOP 10 2023 COMPLIANCE
═══════════════════════════════════════════════════════════════

  A01 — Broken Access Control          : [✅ PASS / ❌ FAIL / ⚠️ PARTIAL]
  A02 — Cryptographic Failures         : [✅ PASS / ❌ FAIL / ⚠️ PARTIAL]
  A03 — Injection                      : [✅ PASS / ❌ FAIL / ⚠️ PARTIAL]
  A04 — Insecure Design                : [✅ PASS / ❌ FAIL / ⚠️ PARTIAL]
  A05 — Security Misconfiguration      : [✅ PASS / ❌ FAIL / ⚠️ PARTIAL]
  A06 — Vulnerable Components          : [✅ PASS / ❌ FAIL / ⚠️ PARTIAL]
  A07 — Auth & Session Failures        : [✅ PASS / ❌ FAIL / ⚠️ PARTIAL]
  A08 — Software & Data Integrity      : [✅ PASS / ❌ FAIL / ⚠️ PARTIAL]
  A09 — Security Logging & Monitoring  : [✅ PASS / ❌ FAIL / ⚠️ PARTIAL]
  A10 — Server-Side Request Forgery    : [✅ PASS / ❌ FAIL / ⚠️ PARTIAL]

═══════════════════════════════════════════════════════════════
              PRIORITISED REMEDIATION PLAN
═══════════════════════════════════════════════════════════════

PHASE 1 — IMMEDIATE (Week 1)
  Objective: Eliminate all critical risks
  ┌──────────────────────────────────────────────────────────┐
  │ □ VULN-WEB-001 : [Title]          Owner: Dev team       │
  │ □ VULN-WEB-002 : [Title]          Owner: DevOps         │
  │ □ VULN-WEB-003 : [Title]          Owner: Dev team       │
  └──────────────────────────────────────────────────────────┘

PHASE 2 — SHORT TERM (Weeks 2-4)
  Objective: Eliminate all high risks
  ┌──────────────────────────────────────────────────────────┐
  │ □ VULN-WEB-004 : [Title]                                │
  │ □ VULN-WEB-005 : [Title]                                │
  └──────────────────────────────────────────────────────────┘

PHASE 3 — MEDIUM TERM (Months 2-3)
  Objective: Address medium risks
  ┌──────────────────────────────────────────────────────────┐
  │ □ VULN-WEB-006 : [Title]                                │
  │ □ VULN-WEB-007 : [Title]                                │
  └──────────────────────────────────────────────────────────┘

PHASE 4 — LONG TERM (Backlog)
  ┌──────────────────────────────────────────────────────────┐
  │ □ [Architecture recommendations]                        │
  │ □ [Process improvements]                                │
  │ □ [Team training]                                       │
  └──────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
              ARCHITECTURAL RECOMMENDATIONS
═══════════════════════════════════════════════════════════════

Beyond code fixes, these structural improvements
would significantly strengthen the security posture:

1. [Architecture recommendation 1]
   Why: [Justification]
   How  : [Direction to take]

2. [Architecture recommendation 2]

3. [Process recommendation: WAF, regular pentest, security review,
   team training, bug bounty, etc.]

═══════════════════════════════════════════════════════════════
              CONCLUSION
═══════════════════════════════════════════════════════════════

[Synthesis in 3-5 sentences of the overall security level,
positive points identified, and remediation effort.
Professional but direct tone.]

[Final recommendation: Go / No-Go for production]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Report generated by CyberAudit Skill v3.1.5
This report is CONFIDENTIAL. Restricted distribution.
For any questions: use CyberAudit in Q&A mode
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
