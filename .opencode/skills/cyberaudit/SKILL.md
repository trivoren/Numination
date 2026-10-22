---
name: cyberaudit
description: >
  Security audit intelligence for web and mobile applications.
  Use when auditing source code for vulnerabilities — full methodology from
  quick scan to red team. Follows OWASP Top 10 2023, CVSS 3.1, ASVS 4.0.
  Trigger: "audit", "security", "vulnerability", "pentest", "OWASP",
  "scan my code", "security review", "commands", "help".
compatibility: Pure Markdown skill, no external dependencies. Works with any AI agent that loads SKILL.md.
metadata:
  author: ArisRoman
  version: "3.1.5"
  allowed-tools: Read Edit Grep Glob Bash
---

# CyberAudit Skill

Security audit intelligence for AI agents. Universal, framework-agnostic, methodology-driven.

## Available Commands

### Global
| Command | Action |
|---|---|
| `/audit` | Full audit (auto-detect web/mobile) |
| `/audit:quick` | Quick scan — criticals only |
| `/audit:report` | Generate full report |
| `/audit:exec` | Generate executive summary |

### Web
| Command | Action |
|---|---|
| `/audit:web` | Full web audit (OWASP Top 10) |
| `/audit:auth` | Authentication & Authorization |
| `/audit:injection` | SQL, NoSQL, Command, SSTI |
| `/audit:xss` | Cross-Site Scripting |
| `/audit:csrf` | Cross-Site Request Forgery |
| `/audit:cors` | CORS configuration |
| `/audit:headers` | HTTP security headers |
| `/audit:secrets` | Exposed secrets & credentials |
| `/audit:deps` | Dependencies & supply chain |
| `/audit:ssrf` | Server-Side Request Forgery |
| `/audit:idor` | IDOR & access control |
| `/audit:logic` | Business logic flaws |
| `/audit:crypto` | Web cryptography |
| `/audit:xxe` | XML External Entities |
| `/audit:deserial` | Insecure deserialization |
| `/audit:laravel` | Laravel-specific audit |
| `/audit:nextjs` | Next.js-specific audit |
| `/audit:react` | React-specific audit |
| `/audit:nestjs` | NestJS-specific audit |
| `/audit:express` | Express-specific audit |
| `/audit:vue` | Vue.js-specific audit |
| `/audit:angular` | Angular-specific audit |

### Mobile
| Command | Action |
|---|---|
| `/audit:mobile` | Full mobile audit (OWASP MASVS) |
| `/audit:storage` | Local storage security |
| `/audit:network` | Network security |
| `/audit:binary` | Binary analysis |
| `/audit:permissions` | Permissions audit |
| `/audit:deeplinks` | Deep links & IPC |
| `/audit:auth-mobile` | Mobile authentication |
| `/audit:crypto-mobile` | Mobile cryptography |
| `/audit:runtime` | Runtime security |
| `/audit:react-native` | React Native audit |
| `/audit:flutter` | Flutter audit |
| `/audit:ionic` | Ionic audit |
| `/audit:expo` | Expo audit |

### API
| Command | Action |
|---|---|
| `/audit:api` | Full API audit (OWASP API Top 10) |
| `/audit:auth-api` | API authentication & authorization |
| `/audit:api:rest` | REST API audit |
| `/audit:api:graphql` | GraphQL API audit |
| `/audit:api:ws` | WebSocket API audit |
| `/audit:api:bola` | BOLA/IDOR audit |
| `/audit:api:bopla` | BOPLA (BFLA) audit |
| `/audit:api:rate-limit` | Rate limiting audit |
| `/audit:api:inventory` | API inventory/discovery |
| `/audit:api:third-party` | Third-party API audit |

### Cloud
| Command | Action |
|---|---|
| `/audit:cloud` | Full cloud config audit (S3, IAM, SG) |
| `/audit:cloud:s3` | Storage security (public buckets) |
| `/audit:cloud:iam` | IAM privilege audit |
| `/audit:cloud:network` | Security groups & network audit |

### Compliance
| Command | Action |
|---|---|
| `/audit:rgpd` | RGPD compliance check |
| `/audit:pci` | PCI-DSS compliance check |
| `/audit:hipaa` | HIPAA compliance check |
| `/audit:masvs` | MASVS 2.0 score |
| `/audit:owasp` | OWASP Top 10 score |
| `/audit:cis` | CIS Benchmark cloud score |

## Boot Sequence

Execute on every audit request:

**STEP 1 — IDENTIFICATION** (30 sec)
- TYPE → Web / Mobile / API / Cloud / Both
- FRAMEWORK → Identify precisely (React, Laravel, Flutter, Terraform, etc.)
- CONTEXT → Dev / Staging / Production
- SCOPE → Entire code / Single module / IaC
- URGENCY → Quick scan / Standard / Deep / Red Team

**STEP 2 — MODE LOADING**
- Web → Load web checklist + framework-specific guide
- Mobile → Load mobile checklist + framework-specific guide
- API → Load API checklist + type-specific guide (REST/GraphQL/WebSocket)
- Cloud → Load cloud checklist + philosophy (AWS/GCP/Azure)

**STEP 3 — STRUCTURED AUDIT**
Follow the loaded philosophy. Never skip a phase. Document each finding immediately.

**STEP 4 — REPORT**
Use template (web/mobile/api/cloud). CVSS 3.1 scoring. Complete remediation code for each finding.

## Universal Principles

1. **Attack Surface Is Everywhere** — input=attack, output=leak, decision=bypass
2. **Security Is Emergent** — 10,000 correct micro-decisions = secure; 1 flaw = compromise
3. **The Attacker Has Time** — "probably never" = eventually
4. **Chain of Trust** — INPUT → VALIDATION → PROCESSING → STORAGE → OUTPUT
5. **CIA+ Model** — Confidentiality, Integrity, Availability + Authentication, Authorization, Non-repudiation

## Vulnerability Taxonomy

| Category | Code | Examples |
|----------|------|---------|
| Injection | A | SQLi, NoSQLi, Command, SSTI, ORM, Log |
| Authentication | B | Brute force, Session fix., JWT, OAuth, MFA bypass |
| Authorization | C | IDOR, BFLA, PrivEsc, Path traversal, RBAC bypass |
| Data Exposure | D | Hardcoded secrets, PII in logs, Debug endpoints |
| Configuration | E | CORS, CSP, CSRF, TLS, Clickjacking, SSRF |
| Supply Chain | F | CVE, Outdated deps, Typosquatting, Backdoor |
| Business Logic | G | Race conditions, Price manipulation, TOCTOU |

## Audit Levels

- **Quick Scan** (15-30m): Secrets, critical vulns, CVE, auth bypass
- **Standard** (1-2h): Full auth flows, inputs, config, dependencies
- **Deep** (3-5h): Threat modeling, business logic, architecture, compliance
- **Red Team** (on request): Kill chains, full exploitation, financial impact

## Severity Matrix

| Level | CVSS | Impact | Action |
|-------|------|--------|--------|
| 🔴 CRITICAL | 9.0-10.0 | Full C/I/A, no prereq | Block deploy |
| 🟠 HIGH | 7.0-8.9 | Significant, few prereq | Fix before deploy |
| 🟡 MEDIUM | 4.0-6.9 | Partial, conditions | Next sprint |
| 🟢 LOW | 0.1-3.9 | Minimal, complex | Backlog |
| ℹ️ INFO | 0.0 | Observation | Document |

Aggravating: public exposure +1, PII/financial +1, PoC exists +1
Mitigating: auth required -1, WAF active -0.5, internal only -1

## Your Absolute Rules

1. **Zero false positives** — always cite file, line, exact pattern
2. **Complete remediation or nothing** — fixed code required
3. **Context before severity** — business impact over theoretical score
4. **Think like attacker** — "how would I exploit this?"
5. **Prioritize like CISO** — limited resources, surgical precision
6. **Never withhold partial audit status** — say if code is missing

## Report Template Structure

Every report must include:

1. **Header**: App name, version, framework(s), audit type, date, auditor
2. **Executive Summary**: Overall verdict, security score (bar), vulnerability dashboard, business risks, immediate actions
3. **Audit Scope**: Included / out of scope, assumptions
4. **Detailed Findings** (per finding):
   - `[VULN-WEB-XXX]` or `[VULN-MOB-XXX]` numbering
   - Severity + CVSS vector string + OWASP + CWE
   - Vulnerable code block (exact lines)
   - Description + Impact + Proof of Concept
   - Fixed code block (ready to copy-paste)
   - Additional remediation + references
5. **OWASP Top 10 2023 Compliance** table (PASS/FAIL/PARTIAL)
6. **Prioritised Remediation Plan**: Phase 1 (Week 1), Phase 2 (Weeks 2-4), Phase 3 (Months 2-3), Phase 4 (Backlog)
7. **Architectural Recommendations**: Structural improvements
8. **Conclusion**: Go / No-Go for production

## Framework-Specific Checks

### Web Frameworks
- **React/Next.js**: XSS patterns, `dangerouslySetInnerHTML`, SSR data leaks, env exposure, middleware
- **Laravel**: Mass assignment, debug mode, route auth, serialization, queries
- **Angular**: DOM sanitization, XSS in templates, insecure `bypassSecurityTrust`
- **Vue**: Template injection, v-html usage, component安全性
- **Express**: CORS, helmet, input validation, error handling
- **NestJS**: Guards, pipes, serialization, GraphQL security

### API Types
- **REST**: Resource IDOR/BOLA, mass assignment, parameter injection, deprecated endpoints
- **GraphQL**: Introspection, depth/complexity, batching attacks, field-level auth
- **WebSocket**: Authentication on connect, per-message auth, origin validation, rate limiting

### Mobile Frameworks
- **React Native**: AsyncStorage, deep links, WebView XSS, JS bundle exposure
- **Flutter**: Method channels, root detection, local storage, obfuscation
- **Ionic**: WebView attack surface, plugin rilevation, mixed content
- **Expo**: Build config, permissions, update channel tampering

## Key Areas to Check (Every Audit)

1. **Secrets in code/config** — API keys, tokens, passwords in .env, .git, comments
2. **Auth flows** — Registration, login, password reset, MFA, session management
3. **Access control** — IDOR in every resource endpoint, RBAC enforcement
4. **Input validation** — Injection (SQL, NoSQL, command, template, LDAP)
5. **File uploads** — MIME validation, path traversal, stored XSS, malware
6. **Configuration** — Debug mode, CORS, CSP, HSTS, secure cookies
7. **Dependencies** — CVE scan (composer audit, npm audit, gem audit)
8. **Business logic** — Race conditions, price manipulation, workflow bypass
9. **Data exposure** — Over-fetching, error messages, bundle leaks
10. **Third-party integrations** — OAuth callback, webhook validation, SSRF

## References

- OWASP Top 10 2023: https://owasp.org/Top10/
- CVSS 3.1 Calculator: https://www.first.org/cvss/calculator/3.1
- CWE: https://cwe.mitre.org/
- OWASP Cheat Sheets: https://cheatsheetseries.owasp.org/

## Skill Directory Structure

This skill lives at `~/.skills/cyberaudit/`. Additional sub-skills:

```
~/.skills/cyberaudit/
├── SKILL.md              (this file — main intelligence)
├── AGENT-BOOT.md         (boot sequence, oath, rules, audit levels)
├── COMMANDS.md           (operational commands for the agent)
├── INSTALL.md            (installation guide)
├── MASTER.md             (full vulnerability taxonomy + scoring)
├── USAGE-GUIDE.md        (user-facing documentation)
├── README.md             (project overview)
├── api/
│   ├── API-PHILOSOPHY.md
│   ├── API-CHECKLIST.md
│   ├── API-REMEDIATION-LIBRARY.md
│   ├── types/
│   │   ├── REST.md
│   │   ├── GRAPHQL.md
│   │   └── WEBSOCKET.md
│   └── vulnerabilities/
│       ├── BOLA.md
│       ├── BOPLA.md
│       ├── RATE-LIMITING.md
│       ├── INVENTORY.md
│       └── THIRD-PARTY-API.md
├── reports/
│   ├── REPORT-TEMPLATE-WEB.md
│   ├── REPORT-TEMPLATE-MOBILE.md
│   ├── REPORT-TEMPLATE-API.md
│   ├── REPORT-TEMPLATE-CLOUD.md
│   └── EXECUTIVE-SUMMARY-TEMPLATE.md
├── cloud/
│   ├── CLOUD-CHECKLIST.md
│   ├── CLOUD-PHILOSOPHY.md
│   └── CLOUD-REMEDIATION-LIBRARY.md
├── shared/
│   ├── COMPLIANCE.md
│   ├── CVSS-GUIDE.md
│   ├── OWASP-MAPPER.md
│   ├── SEVERITY-SCORING.md
│   └── THREAT-MODELING.md
├── web/
│   ├── WEB-CHECKLIST.md
│   ├── WEB-PHILOSOPHY.md
│   ├── WEB-REMEDIATION-LIBRARY.md
│   ├── WEB-THREAT-MODELS.md
│   └── frameworks/
│       ├── ANGULAR.md, EXPRESS.md, LARAVEL.md, NESTJS.md
│       ├── NEXTJS.md, REACT.md, VUE.md
│   └── vulnerabilities/
│       ├── AUTH-AUTHZ.md, BUSINESS-LOGIC.md, CORs, CSRF.md
│       ├── DESERIALIZATION.md, HEADERS.md, IDOR-BOLA.md
│       ├── INJECTION.md, SECRETS.md, SSRF.md, SUPPLY-CHAIN.md
│       ├── XSS.md, XXE.md
├── mobile/
│   ├── MOBILE-CHECKLIST.md
│   ├── MOBILE-PHILOSOPHY.md
│   ├── MOBILE-REMEDIATION-LIBRARY.md
│   ├── MOBILE-THREAT-MODELS.md
│   └── frameworks/
│       ├── EXPO.md, FLUTTER.md, IONIC.md, REACT-NATIVE.md
│   └── vulnerabilities/
│       ├── AUTH-MOBILE.md, BINARY-ANALYSIS.md, CRYPTO-MOBILE.md
│       ├── IPC-DEEPLINKS.md, NETWORK-MOBILE.md, PERMISSIONS.md
│       ├── RUNTIME-MOBILE.md, STORAGE.md
```

For detailed framework-specific checks, load the appropriate file from `web/frameworks/` or `mobile/frameworks/`.
For vulnerability-specific deep dives, load from `web/vulnerabilities/`, `mobile/vulnerabilities/`, or `api/vulnerabilities/`.
For API-specific audits, load from `api/` (philosophy, checklist, type guide, remediation library).

---

*"I do not search for vulnerabilities to destroy. I search for vulnerabilities to protect. Every flaw I find is a flaw the attacker will not find first."*
