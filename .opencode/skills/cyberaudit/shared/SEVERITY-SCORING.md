# 🎯 SCORING GUIDE — CYBERAUDIT SKILL
# How to accurately assess each vulnerability

═══════════════════════════════════════════════════════════════
               CVSS 3.1 SCORING METHOD
═══════════════════════════════════════════════════════════════

CVSS VECTOR : AV:[X]/AC:[X]/PR:[X]/UI:[X]/S:[X]/C:[X]/I:[X]/A:[X]

AV — ATTACK VECTOR (How does the attacker reach the target?)
  N = Network      : Via internet (worst case)
  A = Adjacent     : Same local network
  L = Local        : Local access required
  P = Physical     : Physical access required (best case)

AC — ATTACK COMPLEXITY (Difficult to exploit?)
  L = Low    : No special conditions
  H = High   : Specific conditions required (race condition, etc.)

PR — PRIVILEGES REQUIRED (Required privileges?)
  N = None   : Anonymous (worst case)
  L = Low    : Normal user
  H = High   : Admin/Root required

UI — USER INTERACTION (User interaction needed?)
  N = None     : Direct exploitation
  R = Required : Victim must click/take an action

S — SCOPE (Impact beyond the vulnerable component?)
  U = Unchanged : Impact limited to the component
  C = Changed   : Impact on other components (worse)

C — CONFIDENTIALITY IMPACT
  H = High   : All data exposed
  L = Low    : Partial data exposed
  N = None   : No confidentiality impact

I — INTEGRITY IMPACT
  H = High   : All data modifiable
  L = Low    : Partial modification possible
  N = None   : No integrity impact

A — AVAILABILITY IMPACT
  H = High   : Service completely unavailable
  L = Low    : Partial degradation
  N = None   : No availability impact

═══════════════════════════════════════════════════════════════
               REAL-WORLD SCORING EXAMPLES
═══════════════════════════════════════════════════════════════

SQL INJECTION ON PUBLIC LOGIN
  AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H
  Score : 10.0 CRITICAL
  Reason : Network, easy, anonymous, no interaction,
           total impact on entire system

IDOR ON AUTHENTICATED API  
  AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:L/A:N
  Score : 7.1 HIGH
  Reason : Network, easy, but auth required,
           full read but limited modification

REFLECTED XSS WITH CSP
  AV:N/AC:H/PR:N/UI:R/S:C/C:L/I:L/A:N
  Score : 4.7 MEDIUM
  Reason : CSP mitigates impact, interaction required,
           higher complexity with partial CSP

MISSING X-CONTENT-TYPE-OPTIONS HEADER
  AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N
  Score : 3.1 LOW
  Reason : Complex exploitation, interaction required,
           limited impact

═══════════════════════════════════════════════════════════════
               SCORING DECISIONS FOR THE AGENT
═══════════════════════════════════════════════════════════════

WHEN TO RAISE ONE LEVEL:
  → Endpoint is accessible without authentication
  → PII/financial/health data is involved
  → Exploitation is documented with a public PoC
  → The vulnerability is in the critical path (auth, payment)
  → No other protection layers

WHEN TO LOWER ONE LEVEL:
  → Authentication required to exploit
  → Only non-sensitive data impacted
  → WAF or other protection in place and effective
  → Internal network access only
  → Exploitation requires very specific conditions

ABSOLUTE SCORING RULES:
  → Hardcoded prod secrets = CRITICAL minimum (always)
  → SQLi without auth on user data = CRITICAL (always)
  → Debug mode in production = HIGH minimum (always)
  → MD5/SHA1 password = CRITICAL (always)
  → JWT algorithm:none = CRITICAL (always)
  → AsyncStorage with auth token = HIGH (always)
  → Missing certificate pinning on financial app = CRITICAL
  → Missing certificate pinning on standard app = HIGH
