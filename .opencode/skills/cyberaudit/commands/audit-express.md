---
description: Express-specific audit
---
Express-specific audit — /audit:express

1. Load web/frameworks/EXPRESS.md
2. Check helmet, cors, middleware order (auth before routes), next() after error, input validation

Output:
- Findings with [VULN-...] numbering, CVSS 3.1 vector, file:line, vulnerable code, fixed code, references.
- Use templates from reports/ if needed.
