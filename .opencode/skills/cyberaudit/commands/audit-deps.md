---
description: Dependencies & supply chain audit
---
Dependencies & supply chain audit — /audit:deps

1. Load web/vulnerabilities/SUPPLY-CHAIN.md
2. Run npm audit / composer audit, check lock files, outdated frameworks, abandoned deps

Output:
- Findings with [VULN-...] numbering, CVSS 3.1 vector, file:line, vulnerable code, fixed code, references.
- Use templates from reports/ if needed.
