---
description: WebSocket API audit
---
WebSocket API audit — /audit:api:ws

1. Load api/types/WEBSOCKET.md
2. Check auth on connect, per-message auth, origin validation, rate limiting, WSS only

Output:
- Findings with [VULN-...] numbering, CVSS 3.1 vector, file:line, vulnerable code, fixed code, references.
- Use templates from reports/ if needed.
