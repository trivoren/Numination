# CyberAudit Skill

Security audit intelligence for AI agents. Pure Markdown, deterministic CLI + MCP.

## Coverage

| Domain | Detail |
|---|---|
| **Web** | 7 frameworks (React, Next.js, Laravel, NestJS, Express, Vue, Angular), 13 vulnerability types |
| **Mobile** | 4 frameworks (React Native, Flutter, Ionic, Expo), 8 vulnerability types |
| **API** | 3 types (REST, GraphQL, WebSocket), 5 vuln categories (BOLA, BOPLA, rate-limit, inventory, third-party) |
| **Cloud** | S3 public, IAM wildcard, SG open, IMDSv1, secrets in IaC, CloudTrail (CIS benchmark) |
| **Scoring** | CVSS 3.1 with aggravating/mitigating context factors |
| **Compliance** | RGPD, PCI-DSS, HIPAA, SOC 2, CIS |
| **Reports** | Web + Mobile + API + Cloud + Executive Summary templates |
| **Commands** | 60 slash-commands (`/audit:web`, `/audit:cloud:s3`, etc.) |

## Files

```
AGENT-BOOT.md      Boot sequence, oath, audit levels
SKILL.md           Main intelligence, taxonomy, rules
COMMANDS.md        Operational commands (60 commands)
USAGE-GUIDE.md     User-facing guide
MASTER.md          Full vulnerability taxonomy + scoring
web/               Web audit checklists, per-framework guides
mobile/            Mobile audit checklists, per-framework guides
api/               API checklists + type guides
cloud/             Cloud checklists, philosophy, remediation (S3, IAM, SG)
shared/            Scoring, CVSS, OWASP mapping, compliance
reports/           Report templates (web, mobile, api, cloud, executive)
commands/          60 command definitions for OpenCode autocomplete
```

## Audit Levels

- **Quick Scan** (15-30 min): Secrets, critical CVEs, auth bypass
- **Standard** (1-2h): Full auth, inputs, config, dependencies
- **Deep** (3-5h): Threat modeling, business logic, architecture
- **Red Team** (on request): Kill chains, full exploitation

## Install

```bash
npx -y cyberaudit-skill install
```

## CLI

```bash
npx -y cyberaudit-skill list
npx -y cyberaudit-skill install --dry-run
npx -y cyberaudit-skill serve # MCP server
npm test # 14 tests
```

## License

MIT
