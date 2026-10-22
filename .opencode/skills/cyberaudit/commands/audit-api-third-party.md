---
description: Third-party API audit
---
Third-party API audit — /audit:api:third-party

1. Load api/vulnerabilities/THIRD-PARTY-API.md
2. Check outgoing HTTPS, cert validation, timeouts, webhook HMAC, data treated as untrusted

Output:
- Findings with [VULN-...] numbering, CVSS 3.1 vector, file:line, vulnerable code, fixed code, references.
- Use templates from reports/ if needed.
