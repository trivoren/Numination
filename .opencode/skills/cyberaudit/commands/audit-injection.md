---
description: Injection audit — SQL, NoSQL, Command, SSTI
---
Injection audit — SQL, NoSQL, Command, SSTI — /audit:injection

1. Load web/vulnerabilities/INJECTION.md
2. Scan for string interpolation in SQL/NoSQL, exec/system with user input, template rendering with user input
3. Propose parameterized queries, mongoSanitize, execFile

Output:
- Findings with [VULN-...] numbering, CVSS 3.1 vector, file:line, vulnerable code, fixed code, references.
- Use templates from reports/ if needed.
