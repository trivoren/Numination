# 📱 SECURITY AUDIT REPORT — MOBILE APPLICATION
# Official CyberAudit Skill Template — MASVS 2.0 Aligned

═══════════════════════════════════════════════════════════════
              REPORT HEADER
═══════════════════════════════════════════════════════════════

MOBILE SECURITY AUDIT REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Application      : [APPLICATION NAME]
Version          : [APP VERSION]
Framework        : [React Native / Flutter / Ionic / Expo]
Platforms        : [Android / iOS / Both]
Android Version  : [Min SDK / Target SDK]
iOS Version      : [Deployment Target]
Audit type       : Mobile Application Security Audit
Audit level      : [Quick Scan / Standard / Deep / Red Team]
Date             : [DATE]
Auditor          : CyberAudit Intelligence v3.1.5
Confidentiality  : 🔴 CONFIDENTIAL — Internal use only

═══════════════════════════════════════════════════════════════
              EXECUTIVE SUMMARY
═══════════════════════════════════════════════════════════════

OVERALL VERDICT: [🔴 CRITICAL / 🟠 HIGH / 🟡 MODERATE / 🟢 ACCEPTABLE]

OVERALL SECURITY SCORE: [XX]/100

  [████████████░░░░░░░░] [XX]%

  0-20  : 🔴 Critical  — Store publication BLOCKED
  21-40 : 🟠 High      — Major fixes before publication
  41-60 : 🟡 Moderate  — Significant fixes required
  61-80 : 🟢 Good      — Some fixes recommended
  81-100: ✅ Excellent  — Ready for publication

SCORES BY PLATFORM
━━━━━━━━━━━━━━━━━━━━━

  Android : [XX]/100  [████████░░░░░░░░░░░░]
  iOS     : [XX]/100  [██████████░░░░░░░░░░]

VULNERABILITY DASHBOARD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  🔴 CRITICAL : [N] vulnerability(ies)  → Block publication
  🟠 HIGH     : [N] vulnerability(ies)  → Fix before publication
  🟡 MEDIUM   : [N] vulnerability(ies)  → Fix within 30 days
  🟢 LOW      : [N] vulnerability(ies)  → Security backlog
  ℹ️  INFO     : [N] observation(s)     → Recommendations

  TOTAL : [N] findings

BREAKDOWN BY MASVS CATEGORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  MASVS-STORAGE   : [N] finding(s)  — [🔴/🟠/🟡/🟢]
  MASVS-CRYPTO    : [N] finding(s)  — [🔴/🟠/🟡/🟢]
  MASVS-AUTH      : [N] finding(s)  — [🔴/🟠/🟡/🟢]
  MASVS-NETWORK   : [N] finding(s)  — [🔴/🟠/🟡/🟢]
  MASVS-PLATFORM  : [N] finding(s)  — [🔴/🟠/🟡/🟢]
  MASVS-CODE      : [N] finding(s)  — [🔴/🟠/🟡/🟢]
  MASVS-RESILIENCE: [N] finding(s)  — [🔴/🟠/🟡/🟢]

IDENTIFIED BUSINESS RISKS
━━━━━━━━━━━━━━━━━━━━━━━━━━

  → [Risk 1 in business language — e.g., user session theft]
  → [Risk 2 — e.g., financial data interception]
  → [Risk 3 — e.g., unauthorised access to personal data]
  → [Legal/compliance risk if GDPR/PCI-DSS/HIPAA involved]

IMMEDIATE ACTIONS REQUIRED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  1. [Critical action 1 — affected file/module]
  2. [Critical action 2]
  3. [Critical action 3]

═══════════════════════════════════════════════════════════════
              CONTEXT AND SCOPE
═══════════════════════════════════════════════════════════════

APPLICATION DESCRIPTION
  [Short description of the app, its business domain,
   target audience, data it processes]

TYPE OF DATA PROCESSED
  □ Personal data (PII)
  □ Financial / banking data
  □ Health data
  □ Location data
  □ Biometric data
  □ User credentials
  □ [Other: specify]

INCLUDED IN AUDIT
  ✅ Source code [framework]
  ✅ AndroidManifest.xml
  ✅ Info.plist
  ✅ Network configuration
  ✅ Dependencies (package.json / pubspec.yaml)
  ✅ [Other audited element]

OUT OF SCOPE
  ⭕ Backend API (audited separately)
  ⭕ [Other out-of-scope element — justification]

ASSUMPTIONS AND LIMITATIONS
  → Static audit only (no testing on physical device)
  → No decompilation of the final binary
  → [Other limitation]

═══════════════════════════════════════════════════════════════
              DETAILED FINDINGS
═══════════════════════════════════════════════════════════════

Agent instructions:
Group findings by severity (CRITICAL first).
Use the exact format below for each finding.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[VULN-MOB-001] — [VULNERABILITY TITLE]
─────────────────────────────────────────────

  Severity      : 🔴 CRITICAL
  CVSS Score    : [X.X]
  CVSS Vector   : CVSS:3.1/AV:[X]/AC:[X]/PR:[X]/UI:[X]/S:[X]/C:[X]/I:[X]/A:[X]
  Category      : [Storage / Network / Auth / Platform / Code / Crypto / Resilience]
  MASVS         : [MASVS-STORAGE-1 / MASVS-NETWORK-2 / etc.]
  OWASP Mobile  : [M1 / M2 / M3 / etc.]
  Platform(s)   : [Android / iOS / Both]

  File(s)       : [path/to/file]
  Line(s)       : [N]

  ┌─ VULNERABLE CODE / CONFIGURATION ─────────────────────────┐
  │                                                            │
  │  [Exact code or configuration showing the vulnerability]  │
  │  [Annotated to show the precise problem]                 │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  DESCRIPTION
  ───────────
  [Clear explanation of the vulnerability.
   What happens, why it is dangerous in a mobile context.
   2-4 sentences maximum.]

  EXPLOITATION SCENARIO
  ────────────────────────
  [Realistic scenario adapted to mobile:
   "An attacker with physical access to the device can..."
   "Via a MitM proxy on a public WiFi network..."
   "After APK decompilation with jadx..."]

  IMPACT
  ──────
  Technical  : [Precise technical impact]
  Business   : [Impact on the company and users]
  Compliance : [GDPR / PCI-DSS / HIPAA impact if applicable]

  ┌─ FIXED CODE ──────────────────────────────────────────────┐
  │                                                            │
  │  [Complete fixed code]                                    │
  │  [Comments explaining each protection]                   │
  │  [Ready to copy-paste]                                    │
  │                                                            │
  └────────────────────────────────────────────────────────────┘

  ADDITIONAL CONFIGURATION
  ─────────────────────────────
  [If applicable: AndroidManifest.xml, Info.plist,
   network_security_config.xml to modify]

  REGRESSION TESTS
  ────────────────────
  → [Test to write to verify the fix holds]
  → [How to validate the fix manually]

  REFERENCES
  ──────────
  → [OWASP MASVS link]
  → [OWASP Mobile Top 10 link]
  → [Android/iOS platform documentation]
  → [CVE if applicable]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Repeat for each finding, grouped by severity]

═══════════════════════════════════════════════════════════════
              COMPONENT ANALYSIS
═══════════════════════════════════════════════════════════════

LOCAL STORAGE
──────────────
  AsyncStorage / SharedPreferences  : [✅ Secure / ❌ Sensitive data detected]
  Keychain / Keystore               : [✅ Used / ⚠️ Missing / ❌ Misconfigured]
  Local database                    : [✅ Encrypted / ❌ Unencrypted / ⭕ N/A]
  Local files                       : [✅ OK / ❌ Sensitive data exposed]
  HTTP cache                        : [✅ Configured / ❌ Sensitive data cached]

NETWORK SECURITY
────────────────
  HTTPS                             : [✅ Exclusive / ❌ HTTP detected]
  Certificate Pinning               : [✅ Implemented / ❌ Missing / ⚠️ Partial]
  Network Security Config (Android) : [✅ Configured / ❌ Missing / ❌ Cleartext allowed]
  App Transport Security (iOS)      : [✅ Configured / ⚠️ Exceptions present]
  TLS Version                       : [✅ TLS 1.2+ / ❌ TLS 1.0/1.1 allowed]

AUTHENTICATION
─────────────────
  Token storage                     : [✅ Keychain/Keystore / ❌ AsyncStorage]
  Token expiration                  : [✅ Configured / ❌ Missing]
  Biometrics                        : [✅ Secure / ❌ Poorly implemented / ⭕ N/A]
  Session timeout                   : [✅ Configured / ❌ Missing]
  Root/jailbreak behavior           : [✅ Handled / ❌ Not handled]

IPC AND DEEP LINKS
──────────────────
  Deep Links / URL Schemes          : [✅ Validated / ❌ Not validated / ⭕ N/A]
  Exported Android Intents          : [✅ Protected / ❌ Exposed / ⭕ N/A]
  WebView                           : [✅ Secure / ❌ Vulnerable / ⭕ N/A]
  Content Providers                 : [✅ Protected / ❌ Exposed / ⭕ N/A]

CODE AND BINARY
────────────────
  Hardcoded secrets                 : [✅ None / ❌ Detected]
  Logs in production                : [✅ Disabled / ❌ Active]
  Debug mode in release             : [✅ Disabled / ❌ Active]
  Obfuscation                       : [✅ Enabled / ❌ Missing / ⭕ N/A]
  Dependencies                      : [✅ Up to date / ⚠️ CVEs detected]

PERMISSIONS
────────────
  Declared permissions              : [List]
  Unnecessary permissions           : [✅ None / ❌ Listed here]
  Permission justification          : [✅ All justified / ⚠️ Questionable]

═══════════════════════════════════════════════════════════════
              OWASP MASVS 2.0 COMPLIANCE
═══════════════════════════════════════════════════════════════

MASVS-STORAGE
  MASVS-STORAGE-1 : No sensitive data in insecure storage  [✅/❌/⚠️]
  MASVS-STORAGE-2 : No sensitive data in logs            [✅/❌/⚠️]
  MASVS-STORAGE-3 : No sensitive data in backups         [✅/❌/⚠️]
  MASVS-STORAGE-4 : Data hidden when app in background        [✅/❌/⚠️]
  MASVS-STORAGE-5 : Keyboard cache disabled on sensitive fields     [✅/❌/⚠️]
  MASVS-STORAGE-6 : Clipboard protected on sensitive data           [✅/❌/⚠️]
  MASVS-STORAGE-7 : Data removed when no longer needed          [✅/❌/⚠️]
  MASVS-STORAGE-8 : Local DB encrypted if sensitive data           [✅/❌/⚠️/N/A]

MASVS-CRYPTO
  MASVS-CRYPTO-1  : Modern cryptographic algorithms             [✅/❌/⚠️]
  MASVS-CRYPTO-2  : Standard implementations only              [✅/❌/⚠️]
  MASVS-CRYPTO-3  : Secure random generation                   [✅/❌/⚠️]
  MASVS-CRYPTO-4  : Secure key management                       [✅/❌/⚠️]
  MASVS-CRYPTO-5  : No hardcoded secrets                         [✅/❌/⚠️]

MASVS-AUTH
  MASVS-AUTH-1    : Auth verified server-side                       [✅/❌/⚠️]
  MASVS-AUTH-2    : Secure session management                   [✅/❌/⚠️]
  MASVS-AUTH-3    : Biometrics correctly implemented               [✅/❌/⚠️/N/A]
  MASVS-AUTH-4    : Strong password policy                  [✅/❌/⚠️]

MASVS-NETWORK
  MASVS-NETWORK-1 : HTTPS exclusively                              [✅/❌/⚠️]
  MASVS-NETWORK-2 : Strict certificate verification                 [✅/❌/⚠️]
  MASVS-NETWORK-3 : Up-to-date network libraries                      [✅/❌/⚠️]

MASVS-PLATFORM
  MASVS-PLATFORM-1: Correct use of platform APIs         [✅/❌/⚠️]
  MASVS-PLATFORM-2: Validated and secured deep links                  [✅/❌/⚠️/N/A]
  MASVS-PLATFORM-3: Secure IPC                                     [✅/❌/⚠️]
  MASVS-PLATFORM-4: Secured WebViews                               [✅/❌/⚠️/N/A]
  MASVS-PLATFORM-5: Android components not unnecessarily exported      [✅/❌/⚠️/N/A]
  MASVS-PLATFORM-6: JS disabled in WebViews if unnecessary            [✅/❌/⚠️/N/A]
  MASVS-PLATFORM-7: Minimal permissions                            [✅/❌/⚠️]

MASVS-CODE
  MASVS-CODE-1    : Security tests in CI/CD pipeline         [✅/❌/⚠️]
  MASVS-CODE-2    : All third-party components up to date                 [✅/❌/⚠️]
  MASVS-CODE-3    : App detects binary manipulation           [✅/❌/⚠️/N/A]
  MASVS-CODE-4    : Obfuscation implemented if necessary            [✅/❌/⚠️/N/A]

MASVS-RESILIENCE (High-security apps only)
  MASVS-RESILIENCE-1: Root/Jailbreak detection                       [✅/❌/⚠️/N/A]
  MASVS-RESILIENCE-2: Anti-tampering                                 [✅/❌/⚠️/N/A]
  MASVS-RESILIENCE-3: Anti-debugging                                 [✅/❌/⚠️/N/A]
  MASVS-RESILIENCE-4: Anti-reverse-engineering                       [✅/❌/⚠️/N/A]

GLOBAL MASVS SCORE
  Compliant items  : [N] / [Total applicable]
  Compliance rate : [XX]%
  Level achieved   : [L1 / L2 / R]

═══════════════════════════════════════════════════════════════
              OWASP MOBILE TOP 10 — MAPPING
═══════════════════════════════════════════════════════════════

  M1  — Improper Credential Usage          : [✅/❌/⚠️]
  M2  — Inadequate Supply Chain Security   : [✅/❌/⚠️]
  M3  — Insecure Authentication/Auth       : [✅/❌/⚠️]
  M4  — Insufficient Input/Output Valid.   : [✅/❌/⚠️]
  M5  — Insecure Communication             : [✅/❌/⚠️]
  M6  — Inadequate Privacy Controls        : [✅/❌/⚠️]
  M7  — Insufficient Binary Protections    : [✅/❌/⚠️]
  M8  — Security Misconfiguration          : [✅/❌/⚠️]
  M9  — Insecure Data Storage              : [✅/❌/⚠️]
  M10 — Insufficient Cryptography          : [✅/❌/⚠️]

═══════════════════════════════════════════════════════════════
              PRIORITISED REMEDIATION PLAN
═══════════════════════════════════════════════════════════════

PHASE 1 — IMMEDIATE (D+0 to D+7)
  Objective: Eliminate all critical risks
  ┌──────────────────────────────────────────────────────────┐
  │ □ VULN-MOB-001 : [Title]                                │
  │   Estimated effort : [XS/S/M/L/XL]                     │
  │   Owner           : [Dev / DevOps / Arch]               │
  │                                                          │
  │ □ VULN-MOB-002 : [Title]                                │
  │   Estimated effort : [XS/S/M/L/XL]                     │
  │   Owner           : [Dev / DevOps / Arch]               │
  └──────────────────────────────────────────────────────────┘

PHASE 2 — SHORT TERM (D+7 to D+30)
  Objective: Eliminate all high risks
  ┌──────────────────────────────────────────────────────────┐
  │ □ VULN-MOB-003 : [Title]                                │
  │ □ VULN-MOB-004 : [Title]                                │
  └──────────────────────────────────────────────────────────┘

PHASE 3 — MEDIUM TERM (D+30 to D+90)
  Objective: Address medium risks
  ┌──────────────────────────────────────────────────────────┐
  │ □ VULN-MOB-005 : [Title]                                │
  │ □ VULN-MOB-006 : [Title]                                │
  └──────────────────────────────────────────────────────────┘

PHASE 4 — LONG TERM (Backlog)
  ┌──────────────────────────────────────────────────────────┐
  │ □ Implement certificate pinning with rotation plan      │
  │ □ Add root/jailbreak detection if sensitive app         │
  │ □ Set up code obfuscation                               │
  │ □ Integrate MobSF in CI/CD pipeline                     │
  │ □ Train the team on mobile security specifics           │
  └──────────────────────────────────────────────────────────┘

TOTAL ESTIMATED EFFORT
  Phase 1 : [XX] man-days
  Phase 2 : [XX] man-days
  Phase 3 : [XX] man-days
  Phase 4 : [XX] man-days
  TOTAL   : [XX] man-days

═══════════════════════════════════════════════════════════════
              ARCHITECTURE & PROCESS RECOMMENDATIONS
═══════════════════════════════════════════════════════════════

ARCHITECTURE
  1. [Recommendation 1 — e.g., Migrate to a zero-trust
     architecture with systematic server-side validation]
     Impact   : [High / Medium / Low]
     Effort   : [XS / S / M / L / XL]

  2. [Recommendation 2 — e.g., Implement a unified security
     SDK to centralise Keychain, logging, pinning]

PROCESS
  1. Integrate MobSF in CI/CD pipeline for static analysis
  2. Test on rooted/jailbroken device at each release
  3. Set up a SSL pin rotation procedure
  4. Perform dynamic pentest before each major release
  5. Train mobile team on MASVS controls

PRODUCTION MONITORING
  1. Implement runtime anomaly detection solution
  2. Monitor failed auth attempts
  3. Alert on connections from rooted devices
  4. Track sensitive data access

═══════════════════════════════════════════════════════════════
              CONCLUSION
═══════════════════════════════════════════════════════════════

[Professional synthesis in 4-6 sentences:
 - Overall observed security level
 - Positive points identified (what is done well)
 - Priority points of attention
 - Overall remediation effort
 - Final recommendation]

FINAL PUBLICATION RECOMMENDATION:

  🔴 NO-GO  — Critical fixes mandatory before publication
  🟠 NO-GO  — High fixes to address before publication  
  🟡 GO conditional — Remediation plan required within 30 days
  🟢 GO     — Application ready for publication

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Report generated by CyberAudit Skill v3.1.5
Aligned with OWASP MASVS 2.0 and OWASP Mobile Top 10
This report is CONFIDENTIAL — Restricted distribution
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
