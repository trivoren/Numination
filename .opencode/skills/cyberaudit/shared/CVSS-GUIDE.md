# 📊 COMPLETE CVSS GUIDE — CYBERAUDIT SKILL
# Common Vulnerability Scoring System v3.1

═══════════════════════════════════════════════════════════════
               CVSS 3.1 — COMPLETE REFERENCE
═══════════════════════════════════════════════════════════════

FORMAT OF THE CVSS VECTOR
───────────────────────
  CVSS:3.1/AV:[X]/AC:[X]/PR:[X]/UI:[X]/S:[X]/C:[X]/I:[X]/A:[X]

BASE METRICS (BASE SCORE)
──────────────────────────────

AV — ATTACK VECTOR
  N (Network)   3.85  Via the Internet or remote network
  A (Adjacent)  2.62  Same network segment (LAN, Bluetooth, WiFi)
  L (Local)     1.55  Local access required (shell, session)
  P (Physical)  0.20  Physical access to the device required

AC — ATTACK COMPLEXITY
  L (Low)   0.77  Reproducible conditions, no special prerequisites
  H (High)  0.44  Specific conditions: race condition, rare config

PR — PRIVILEGES REQUIRED
  N (None)  0.85  Anonymous, no authentication
  L (Low)   0.62  Normal user (0.68 if scope changed)
  H (High)  0.27  Administrator (0.50 if scope changed)

UI — USER INTERACTION
  N (None)     0.85  Exploitation without victim action
  R (Required) 0.62  The victim must click/take an action

S — SCOPE
  U (Unchanged)  Impact limited to the vulnerable component
  C (Changed)    Impact on other components/systems

C — CONFIDENTIALITY IMPACT
  H (High)  0.56  All data exposed, or critical data
  L (Low)   0.22  Partial access, non-critical data
  N (None)  0.00  No impact on confidentiality

I — INTEGRITY IMPACT
  H (High)  0.56  Total modification possible, corrupted data
  L (Low)   0.22  Partial modification possible
  N (None)  0.00  No impact on integrity

A — AVAILABILITY IMPACT
  H (High)  0.56  Service completely unavailable
  L (Low)   0.22  Degradation or partial interruption
  N (None)  0.00  No impact on availability

═══════════════════════════════════════════════════════════════
               QUICK REFERENCE SCORES
═══════════════════════════════════════════════════════════════

CRITICAL (9.0 - 10.0)
  Typical examples :
  
  Unauthenticated SQLi on public endpoint
    AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H = 10.0
  
  RCE via deserialization
    AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H = 10.0
  
  Full auth bypass
    AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H = 9.8
  
  JWT algorithm:none
    AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N = 9.1

HIGH (7.0 - 8.9)
  Typical examples :
  
  IDOR on sensitive data (auth required)
    AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:L/A:N = 7.1
  
  Stored XSS without CSP
    AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:L/A:N = 7.6
  
  SSRF to internal infrastructure
    AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:N = 8.6
  
  Exposed secrets (active API key)
    AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N = 7.5
  
  Missing certificate pinning (critical app)
    AV:A/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:N = 7.4

MEDIUM (4.0 - 6.9)
  Typical examples :
  
  CSRF on non-critical action
    AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N = 6.5
  
  Reflected XSS with partial CSP
    AV:N/AC:H/PR:N/UI:R/S:C/C:L/I:L/A:N = 4.7
  
  Clickjacking on sensitive page
    AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N = 4.3
  
  Open redirect
    AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N = 5.4
  
  AsyncStorage with token (mobile)
    AV:P/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N = 4.6

LOW (0.1 - 3.9)
  Typical examples :
  
  Missing X-Content-Type-Options header
    AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N = 3.1
  
  Information disclosure (framework version)
    AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N = 5.3 → Medium
    
  Cookie without SameSite (limited context)
    AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N = 3.1

═══════════════════════════════════════════════════════════════
               COMMON SCORING MISTAKES
═══════════════════════════════════════════════════════════════

ERROR 1 — Underestimating the Attack Vector
  ❌ AV:L (Local) for a web API
  ✅ AV:N (Network) — accessible via the Internet

ERROR 2 — Ignoring the Scope Changed
  If a SQLi gives access to the entire server:
  S:C (Changed) because the impact goes beyond the application
  This multiplies the score

ERROR 3 — Forgetting the context
  A "critical" vulnerability in theory can be
  "high" in practice if:
  → Auth required (PR:L or PR:H instead of PR:N)
  → Non-sensitive data (C:L instead of C:H)

ERROR 4 — Not using temporal metrics
  Base Score = theoretical score
  Temporal Score = adjusted score based on:
  → Exploit availability
  → Confidence level in the vulnerability
  → Remediation available

═══════════════════════════════════════════════════════════════
               FINAL SEVERITY DECISION
═══════════════════════════════════════════════════════════════

SCORING PROCESS FOR THE AGENT:

  STEP 1 : Calculate the CVSS Base Score
  
  STEP 2 : Apply contextual factors
    → Application publicly exposed? → may increase
    → PII/financial data? → may increase
    → Mitigations in place (WAF, auth)? → may decrease
  
  STEP 3 : Decide the final severity
    9.0-10.0 → CRITICAL
    7.0-8.9  → HIGH
    4.0-6.9  → MEDIUM
    0.1-3.9  → LOW
    0.0      → INFO
  
  STEP 4 : Always cite the full CVSS vector
    CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H
    Score : 9.8 (CRITICAL)

REFERENCE CALCULATOR :
  https://www.first.org/cvss/calculator/3.1
  
  # The 4 Missing Files — Complete Content

---
