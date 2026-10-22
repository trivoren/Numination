---
description: Generate complete audit report with CVSS scoring
---
Generate a complete security audit report.
1. Collect all findings from current session
2. Score each with CVSS 3.1 (vector string + numeric score)
3. Use appropriate report template from reports/
4. Include: executive summary, scope, findings table, detailed findings, remediation plan, compliance table, conclusion
5. Prioritize by severity: CRITICAL → HIGH → MEDIUM → LOW
6. Include fixed code for each finding
