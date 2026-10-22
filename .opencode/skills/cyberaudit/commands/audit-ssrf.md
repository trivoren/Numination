---
description: SSRF audit
---
SSRF audit — /audit:ssrf

1. Load web/vulnerabilities/SSRF.md
2. Check URL fetch with user input, whitelist, block 169.254.169.254, internal IPs

Output:
- Findings with [VULN-...] numbering, CVSS 3.1 vector, file:line, vulnerable code, fixed code, references.
- Use templates from reports/ if needed.
