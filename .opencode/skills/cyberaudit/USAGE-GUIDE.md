# 📖 USAGE GUIDE — CYBERAUDIT SKILL
# For agents, developers, and teams

═══════════════════════════════════════════════════════════════
              HOW TO USE THIS SKILL
═══════════════════════════════════════════════════════════════

FOR AI AGENTS (Cursor, Claude, GPT, Copilot...)
────────────────────────────────────────────────────

  ACTIVATION COMMANDS:

  Full web audit:
    "Audit this [framework] application following
     the CyberAudit Skill. Produce a full report."

  Quick scan:
    "Run a quick security scan on this code.
     Focus on critical and high findings only."

  Single file audit:
    "Audit this controller file using the
     CyberAudit Laravel rules."

  Mobile audit:
    "Audit this React Native app. Check storage,
     network, and deep links per MASVS 2.0."

  PR review:
    "Review this PR from a security perspective.
     Identify any newly introduced risks."

FOR DEVELOPMENT TEAMS
────────────────────────

  WORKFLOW INTEGRATION:

  Pre-commit:
    → Quick scan on modified files
    → Automatic secret detection
    → Result: Go/No-Go in 2 min

  Pull Request:
    → Standard audit on new endpoints
    → Review of auth/authz changes
    → Inline comments on findings

  Pre-deployment:
    → Full audit of the entire scope
    → OWASP compliance validation
    → Certification report

  Post-sprint:
    → Deep audit of one critical module per sprint
    → Progressive reduction of security debt
    → Security score tracking over time

  ENGAGEMENT LEVELS
  ─────────────────────

  BEGINNER (Junior dev)
    → Use checklists as a guide during development
    → Request a quick scan before each commit
    → Learn from the provided remediation code

  INTERMEDIATE (Senior dev)
    → Integrate audit into PR review
    → Understand and contextualize findings
    → Propose fixes before review

  ADVANCED (Tech lead / Architect)
    → Deep audit on critical components
    → Threat modeling on new features
    → Define team security standards

  EXPERT (CISO / Security Engineer)
    → Red team mode for critical systems
    → Validate and complete generated reports
    → Define security KPIs

═══════════════════════════════════════════════════════════════
              RECOMMENDED TRACKING METRICS
═══════════════════════════════════════════════════════════════

  Overall security score        : Target ≥ 80/100
  Open criticals                : Target = 0
  Open highs                    : Target ≤ 2
  Critical MTTR                 : Target < 24h
  High MTTR                     : Target < 7 days
  Audit coverage                : Target 100% of modules
  Audit frequency               : Minimum monthly
  Unpatched critical CVEs       : Target = 0

═══════════════════════════════════════════════════════════════
              MASTER REFERENCES
═══════════════════════════════════════════════════════════════

  OWASP Top 10       : https://owasp.org/Top10/
  OWASP MASVS 2.0    : https://mas.owasp.org/MASVS/
  OWASP Cheat Sheets : https://cheatsheetseries.owasp.org/
  CWE Top 25         : https://cwe.mitre.org/top25/
  CVSS Calculator    : https://www.first.org/cvss/calculator/3.1
  CVE Database       : https://cve.mitre.org/
  NVD                : https://nvd.nist.gov/
  Snyk Vuln DB       : https://snyk.io/vuln/
  npm advisories     : https://github.com/advisories
  SANS Top 25        : https://www.sans.org/top25-software-errors/
