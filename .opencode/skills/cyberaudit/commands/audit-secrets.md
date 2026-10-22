---
description: Exposed secrets & credentials audit
---
Exposed secrets & credentials audit — /audit:secrets

1. Load web/vulnerabilities/SECRETS.md
2. Scan: API keys, tokens, private keys, .env committed, NEXT_PUBLIC_ secrets, comments, git history

Output:
- Findings with [VULN-...] numbering, CVSS 3.1 vector, file:line, vulnerable code, fixed code, references.
- Use templates from reports/ if needed.
