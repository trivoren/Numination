# 📊 EXECUTIVE SUMMARY — CYBERAUDIT SKILL
# Executive summary — For decision-makers and management

═══════════════════════════════════════════════════════════════
  USAGE: This template is used ALONE when the recipient
  is non-technical (CTO, CEO, CISO, client).
  It summarises a full report in 1-2 pages.
  Business language, zero technical jargon.
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

                    SECURITY EXECUTIVE SUMMARY
                    ════════════════════════════

  Application   : [NAME]
  Type          : [Web / Mobile / Web + Mobile]
  Date          : [DATE]
  Reference     : [FULL REPORT ID]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ONE-LINE VERDICT
─────────────────────

  "[The application has critical vulnerabilities
    that expose user data to an immediate
    risk of compromise and block its deployment
    to production as-is.]"

  OR

  "[The application has a satisfactory security level
    with a few improvement points to plan, and can
    be deployed to production after fixing the 2
    high-severity items identified.]"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

KEY INDICATORS
────────────────

  SECURITY SCORE        : [XX]/100
  RISK LEVEL            : [🔴 CRITICAL / 🟠 HIGH / 🟡 MODERATE / 🟢 GOOD]
  PRODUCTION DEPLOYMENT : [🔴 BLOCKED / 🟠 CONDITIONAL / 🟢 AUTHORISED]
  GDPR COMPLIANCE       : [✅ Compliant / ❌ Non-compliant / ⚠️ Partial]
  PCI-DSS COMPLIANCE    : [✅ / ❌ / ⚠️ / N/A]

  VULNERABILITIES FOUND:
  ┌──────────────────────────────────────────────┐
  │  🔴 Critical  : [N]  →  Immediate risk       │
  │  🟠 High      : [N]  →  Significant risk     │
  │  🟡 Medium    : [N]  →  Moderate risk        │
  │  🟢 Low       : [N]  →  Minor risk           │
  │                                              │
  │  TOTAL        : [N]  vulnerabilities         │
  └──────────────────────────────────────────────┘

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHAT THIS MEANS IN PRACTICE
────────────────────────────────────

  Agent instructions:
  Translate technical findings into business risks
  understandable by a non-technical person.
  Use simple analogies. No jargon.

  RISK 1 — [Business title, not technical]
  ┌──────────────────────────────────────────────────────────┐
  │ What happens:                                            │
  │ [Simple explanation — e.g., "An attacker can access     │
  │  the personal data of all your users                     │
  │  without having an account on your platform"]            │
  │                                                          │
  │ Potential impact:                                        │
  │ [Business impact — e.g., "Exposure of X customer        │
  │  data, GDPR fine risk up to 4% of revenue,               │
  │  reputational damage"]                                   │
  │                                                          │
  │ Fix time : [X days]                                      │
  │ Estimated cost : [Low / Medium / High]                   │
  └──────────────────────────────────────────────────────────┘

  RISK 2 — [Business title]
  ┌──────────────────────────────────────────────────────────┐
  │ What happens:                                            │
  │ [Simple explanation]                                     │
  │                                                          │
  │ Potential impact:                                        │
  │ [Business impact]                                        │
  │                                                          │
  │ Fix time : [X days]                                      │
  │ Estimated cost : [Low / Medium / High]                   │
  └──────────────────────────────────────────────────────────┘

  RISK 3 — [Business title]
  ┌──────────────────────────────────────────────────────────┐
  │ What happens:                                            │
  │ [Simple explanation]                                     │
  │                                                          │
  │ Potential impact:                                        │
  │ [Business impact]                                        │
  │                                                          │
  │ Fix time : [X days]                                      │
  │ Estimated cost : [Low / Medium / High]                   │
  └──────────────────────────────────────────────────────────┘

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHAT IS WORKING WELL
────────────────────────

  [Always mention positive points.
   A good security report acknowledges what is done well.]

  ✅ [Positive point 1 — e.g., "Authentication is robust
      with two-factor authentication and protection against
      brute force attacks"]

  ✅ [Positive point 2 — e.g., "Network communications are
      encrypted and certificates are correctly verified"]

  ✅ [Positive point 3]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RECOMMENDED ACTION PLAN
────────────────────────

  WEEK 1 — Immediate actions
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Who    : Development team
  What   : [Critical actions in simple language]
  Budget : [Estimated in man-days]
  Deliverable : Validated critical fixes

  MONTH 1 — Priority actions
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Who    : Development team + DevOps
  What   : [High-severity actions]
  Budget : [Estimated in man-days]
  Deliverable : Remediation report

  QUARTER 1 — Structural improvements
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Who    : Extended team
  What   : [Architecture and process improvements]
  Budget : [Estimated in man-days]
  Deliverable : Level [X] certified application

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INVESTMENT VS RISK
─────────────────────────

  Fix cost    : [XX] man-days ≈ [XX]€

  Cost of a data breach (estimate):
  ┌──────────────────────────────────────────────────┐
  │ Possible GDPR fine       : up to [XX]€           │
  │ Notification cost        : [XX]€ estimated       │
  │ Reputational damage      : [Not quantifiable]    │
  │ Average data breach cost : 4.45M$ (IBM 2023)     │
  │                                                  │
  │ ROI of fixes             : Obvious               │
  └──────────────────────────────────────────────────┘

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DECISION REQUIRED
─────────────────

  □ Approve Phase 1 remediation plan (immediate)
  □ Allocate [N] man-days to the development team
  □ [If NO-GO] Block deployment until fixes are complete
  □ Schedule a follow-up audit in [30/60/90] days
  □ [If applicable] Notify the DPO for GDPR risk

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Full report available : [Report reference]
  For any questions     : Use CyberAudit in Q&A mode

  Generated by CyberAudit Skill v3.1.5
  CONFIDENTIAL document — Management level only

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
