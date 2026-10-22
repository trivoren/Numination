# Rate Limiting — API Abuse Prevention

## Why It Matters

Without rate limiting:
- Brute force: 10,000 passwords tested in 1 minute
- Enumeration: entire user database scraped
- DoS: server overwhelmed by single client
- Financial: costs from cloud API calls

## Implementation Patterns

### By IP
```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=30r/m;
```
Pros: simple, no client changes
Cons: shared IPs (NAT), proxy bypass

### By User ID
```javascript
// After authentication
const key = `ratelimit:${req.user.id}`;
const count = await redis.incr(key);
if (count > 100) return 429;
```
Pros: accurate per user
Cons: requires auth, unauthenticated = IP fallback

### By Token
```javascript
const key = `ratelimit:${req.headers['x-api-key']}`;
```
Pros: works for service accounts
Cons: tokens can be shared

### Hybrid
```javascript
const key = req.user?.id || req.ip;
```
Best approach: authenticated users by ID, anonymous by IP.

## Recommended Limits

| Endpoint Type | Limit | Window |
|--------------|-------|--------|
| Login        | 5     | 15 min |
| Registration | 3     | 1 hour |
| Password Reset| 3    | 1 hour |
| General API  | 100   | 1 min  |
| File Upload  | 10    | 1 hour |
| Search       | 30    | 1 min  |
| WebSocket Msg| 60    | 1 min  |

## Response

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 900
Content-Type: application/json

{
  "error": "rate_limit_exceeded",
  "retry_after_seconds": 900
}
```
