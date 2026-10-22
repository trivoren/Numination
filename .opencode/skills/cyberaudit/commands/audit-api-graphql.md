---
description: GraphQL API audit
---
GraphQL API audit — /audit:api:graphql

1. Load api/types/GRAPHQL.md
2. Check introspection disabled in prod, depth/complexity limits, batching attacks, per-resolver auth

Output:
- Findings with [VULN-...] numbering, CVSS 3.1 vector, file:line, vulnerable code, fixed code, references.
- Use templates from reports/ if needed.
