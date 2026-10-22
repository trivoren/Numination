# CyberAudit Commands

When user types `/cyberaudit` or `/audit` — **list all commands below**.

## Global

| Command | Action |
|---|---|
| `/audit` | Full audit (auto-detect web/mobile) |
| `/audit:quick` | Quick scan — criticals only |
| `/audit:report` | Generate full report |
| `/audit:exec` | Generate executive summary |

## Web

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

## Mobile

| Command | Action |
|---|---|
| `/audit:mobile` | Full mobile audit (MASVS) |
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

## API

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

## Cloud

| Command | Action |
|---|---|
| `/audit:cloud` | Full cloud config audit (CIS, S3, IAM, SG) |
| `/audit:cloud:s3` | Storage / buckets public access |
| `/audit:cloud:iam` | IAM least privilege & wildcards |
| `/audit:cloud:network` | Security Groups & firewall |

## Compliance

| Command | Action |
|---|---|
| `/audit:rgpd` | RGPD compliance check |
| `/audit:pci` | PCI-DSS compliance check |
| `/audit:hipaa` | HIPAA compliance check |
| `/audit:masvs` | MASVS 2.0 score |
| `/audit:owasp` | OWASP Top 10 score |
| `/audit:cis` | CIS Benchmark cloud score |

## Execution

For any `/audit:xxx` command, load the corresponding files from `web/`, `mobile/`, `api/`, `cloud/`, or `reports/`, then execute the audit methodology from `SKILL.md`.
