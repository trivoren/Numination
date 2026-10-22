---
description: REST API audit
---
REST API audit — /audit:api:rest

1. Load api/types/REST.md
2. Check IDOR on every ID, mass assignment whitelist, over-fetching, deprecated v0 endpoints

Output:
- Findings with [VULN-...] numbering, CVSS 3.1 vector, file:line, vulnerable code, fixed code, references.
- Use templates from reports/ if needed.
