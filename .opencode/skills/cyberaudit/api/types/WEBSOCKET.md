# WebSocket API — Security Audit Guide

## Unique Risks

WebSockets are persistent, bidirectional, and often bypass traditional web security controls:
- No per-request headers or cookies after initial handshake
- WAFs struggle to inspect WebSocket traffic
- Long-lived connections increase attack surface

## Vulnerability Patterns

### CRITICAL — No Authentication on Connect
```javascript
const ws = new WebSocket('wss://api.example.com/ws');
// No auth token sent → anyone can connect
```
Fix: require JWT/token in connection header or first message.

### CRITICAL — No Per-Message Authorization
Connection is authenticated, but subsequent messages are not authorized.
```
User connects (valid token) → sends: {"action": "deleteUser", "target": 5}
No check if user is admin or owns user 5.
```
Fix: authorize every message independently.

### HIGH — No Input Validation
```
ws.send(JSON.stringify({ action: "query", sql: "DROP TABLE users" }));
```
Fix: validate all message content server-side. Never trust the client.

### HIGH — Message Injection
If messages are parsed or rendered unescaped:
```
ws.send(JSON.stringify({ action: "chat", message: "<script>...</script>" }));
```
Fix: escape output, strip HTML, validate message schema.

### MEDIUM — No Rate Limiting
Without per-connection rate limiting:
- Message flood
- Resource exhaustion
- Data exfiltration via rapid queries
Fix: rate limit per connection, close connections that exceed limits.

### MEDIUM — No Origin Validation
```javascript
// Server accepts connections from any origin
```
An attacker's website can open WebSocket connections on behalf of logged-in users (CSWSH — Cross-Site WebSocket Hijacking).
Fix: validate Origin header during handshake.

### MEDIUM — No Connection Timeout
Connections stay open indefinitely, consuming resources.
Fix: implement idle timeout, absolute timeout, and heartbeat.

### LOW — Unencrypted Connections
```
const ws = new WebSocket('ws://api.example.com/ws');
```
Fix: mandatory WSS (TLS) for all WebSocket connections.

## WebSocket-Specific Best Practices

1. Authenticate on connection (token in first message or header)
2. Authorize every message independently
3. Validate all message content and schema
4. Rate limit per connection
5. Validate Origin header during handshake
6. Implement idle timeout and absolute timeout
7. Use WSS exclusively (no plain WS)
8. Limit message size
9. Log all connections and disconnections
10. Monitor for abnormal message patterns
