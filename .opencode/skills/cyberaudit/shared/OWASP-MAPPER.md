# 🗺️ OWASP MAPPER — CYBERAUDIT SKILL
# Quick reference OWASP Top 10 Web + MASVS Mobile

═══════════════════════════════════════════════════════════════
               OWASP TOP 10 WEB 2023
═══════════════════════════════════════════════════════════════

A01:2021 — BROKEN ACCESS CONTROL (↑ from #5)
  What it is : Access controls are not enforced
  Examples     : IDOR, Path traversal, CORS misconfigured,
                  Privilege escalation, admin routes without auth
  Detect     : Look for access to resources without
                  ownership or role verification
  Reference    : https://owasp.org/Top10/A01_2021-Broken_Access_Control/

A02:2021 — CRYPTOGRAPHIC FAILURES (↑ from #3)
  What it is : Sensitive data poorly protected in transit or at rest
  Examples     : Unencrypted HTTP, MD5/SHA1 for passwords,
                  hardcoded secrets, plaintext data in database
  Detect     : Look for unencrypted transmissions,
                  weak algorithms, exposed secrets
  Reference    : https://owasp.org/Top10/A02_2021-Cryptographic_Failures/

A03:2021 — INJECTION (↓ from #1)
  What it is : Untrusted data sent to an interpreter
  Examples     : SQLi, NoSQLi, Command injection, XSS, SSTI
  Detect     : Look for unvalidated/unparameterized inputs
                  in queries and templates
  Reference    : https://owasp.org/Top10/A03_2021-Injection/

A04:2021 — INSECURE DESIGN (NEW)
  What it is : Design flaws, not implementation
  Examples     : Missing rate limiting by design,
                  workflow without validation steps,
                  blind trust in sources
  Detect     : Analyze business flows and architecture
  Reference    : https://owasp.org/Top10/A04_2021-Insecure_Design/

A05:2021 — SECURITY MISCONFIGURATION (↑ from #6)
  What it is : Default or incomplete configurations
  Examples     : Debug in prod, missing headers, CORS *, 
                  default accounts, exposed stack traces
  Detect     : Analyze all configurations and headers
  Reference    : https://owasp.org/Top10/A05_2021-Security_Misconfiguration/

A06:2021 — VULNERABLE AND OUTDATED COMPONENTS (↑ from #9)
  What it is : Components with known vulnerabilities
  Examples     : CVEs in npm/composer packages,
                  unpatched frameworks, Log4Shell
  Detect     : npm audit, composer audit, CVE databases
  Reference    : https://owasp.org/Top10/A06_2021-Vulnerable_and_Outdated_Components/

A07:2021 — IDENTIFICATION AND AUTHENTICATION FAILURES (↓ from #2)
  What it is : Flaws in authentication and session management
  Examples     : Brute force possible, weak JWT,
                  session not invalidated, weak passwords allowed
  Detect     : Analyze the entire authentication flow
  Reference    : https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/

A08:2021 — SOFTWARE AND DATA INTEGRITY FAILURES (NEW)
  What it is : Code and infrastructure without integrity verification
  Examples     : Unverified dependencies, insecure CI/CD,
                  unsafe deserialization, unsigned auto-update
  Detect     : Analyze the CI/CD pipeline and dependency management
  Reference    : https://owasp.org/Top10/A08_2021-Software_and_Data_Integrity_Failures/

A09:2021 — SECURITY LOGGING AND MONITORING FAILURES (↑ from #10)
  What it is : Insufficient logging to detect attacks
  Examples     : Missing auth logs, alerts not configured,
                  unreadable logs, no SIEM
  Detect     : Check what is logged and what is not
  Reference    : https://owasp.org/Top10/A09_2021-Security_Logging_and_Monitoring_Failures/

A10:2021 — SERVER-SIDE REQUEST FORGERY (NEW)
  What it is : The app makes requests to unvalidated URLs
  Examples     : Fetching user-supplied URLs,
                  webhooks to internal URLs, resource imports
  Detect     : Look for places where the app makes HTTP
                  requests based on user input
  Reference    : https://owasp.org/Top10/A10_2021-Server-Side_Request_Forgery_(SSRF)/

═══════════════════════════════════════════════════════════════
               OWASP MASVS 2.0 — MOBILE
═══════════════════════════════════════════════════════════════

MASVS-STORAGE — Data Storage
  L1 : No sensitive data in unsecured storage
  L2 : No sensitive data in logs
  L3 : No sensitive data in unencrypted backups
  L4 : Sensitive data cleared if app backgrounded
  Reference : https://mas.owasp.org/MASVS/05-MASVS-STORAGE/

MASVS-CRYPTO — Cryptography
  L1 : Use of modern cryptographic algorithms
  L2 : Standard implementations (not custom)
  L3 : Secrets not hardcoded
  L4 : Cryptographic keys managed securely
  Reference : https://mas.owasp.org/MASVS/06-MASVS-CRYPTO/

MASVS-AUTH — Authentication & Authorization
  L1 : Auth verified server-side
  L2 : Secure session and token management
  L3 : Biometrics correctly implemented
  Reference : https://mas.owasp.org/MASVS/07-MASVS-AUTH/

MASVS-NETWORK — Network Communication
  L1 : HTTPS exclusively
  L2 : Certificate verification correct
  L3 : Certificate pinning on critical endpoints
  Reference : https://mas.owasp.org/MASVS/08-MASVS-NETWORK/

MASVS-PLATFORM — Platform Interactions
  L1 : Correct use of platform APIs
  L2 : Secure WebViews
  L3 : Secure IPC (Intent, URL Schemes, Deep Links)
  L4 : Minimal permissions
  Reference : https://mas.owasp.org/MASVS/09-MASVS-PLATFORM/

MASVS-CODE — Code Quality
  L1 : Dependencies up to date
  L2 : No debug features in prod
  L3 : Proper error handling
  Reference : https://mas.owasp.org/MASVS/10-MASVS-CODE/

MASVS-RESILIENCE — Resilience (highly sensitive apps)
  L1 : Root/Jailbreak detection
  L2 : Anti-tampering
  L3 : Anti-debugging
  L4 : Obfuscation
  Reference : https://mas.owasp.org/MASVS/11-MASVS-RESILIENCE/
