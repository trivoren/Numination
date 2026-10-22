# API SECURITY CHECKLIST — CyberAudit Skill

## Phase 0 — Discovery

- [ ] All endpoints documented and audited
- [ ] Shadow/deprecated endpoints identified
- [ ] Auth mechanism identified per endpoint
- [ ] All HTTP methods tested on each endpoint
- [ ] Parameter variations tested
- [ ] Content-type variations tested

## Phase 1 — Authentication

- [ ] JWT signature verified (not just decoded)
- [ ] JWT `alg` restricted (no "none" algorithm)
- [ ] JWT expiration enforced server-side
- [ ] JWT secret strong and rotated
- [ ] OAuth redirect_uri validated
- [ ] OAuth state parameter used
- [ ] API keys not exposed in URLs
- [ ] API keys revocable
- [ ] API keys scoped to minimum permissions
- [ ] No hardcoded credentials in code
- [ ] Multi-factor authentication available
- [ ] Password hashing: bcrypt/argon2

## Phase 2 — Authorization

- [ ] IDOR test on every object endpoint
- [ ] BFLA test on every admin function
- [ ] Role-based access control enforced
- [ ] Mass assignment protected
- [ ] UUIDs used instead of sequential IDs
- [ ] Object ownership verified server-side
- [ ] Vertical privilege escalation tested
- [ ] Horizontal privilege escalation tested
- [ ] Indirect object reference checked

## Phase 3 — Input Validation

- [ ] SQL injection: parameterized queries
- [ ] NoSQL injection: sanitize operators
- [ ] Command injection: avoid exec() with input
- [ ] XML injection: disable external entities
- [ ] SSRF: validate redirect URLs
- [ ] Path traversal: restrict file access
- [ ] Parameter pollution: last value wins?
- [ ] Schema validation bypass: extra fields
- [ ] Content-type confusion: application/json vs XML
- [ ] GraphQL: depth limiting
- [ ] GraphQL: query complexity limiting
- [ ] GraphQL: disable introspection in production

## Phase 4 — Rate Limiting

- [ ] Rate limiting on ALL endpoints
- [ ] Stricter limits on auth endpoints
- [ ] Rate limiting by user/IP/token
- [ ] Proper 429 response with Retry-After
- [ ] Brute force protection on login
- [ ] Enumeration prevention (consistent messages)
- [ ] Pagination has max limit
- [ ] Pagination cursor-based for sensitive data
- [ ] Resource usage monitoring

## Phase 5 — Data Exposure

- [ ] Responses contain minimum data
- [ ] No sensitive data in error messages
- [ ] No stack traces in production
- [ ] No debug endpoints exposed
- [ ] Logging excludes sensitive fields
- [ ] PII exposure audited per endpoint
- [ ] Consistent response format (no info leak)
- [ ] CORS whitelist restrictive
- [ ] CORS credentials: true without wildcard origin
- [ ] Security headers: CSP, HSTS, X-Frame, etc.

## Phase 6 — WebSocket Security

- [ ] WSS enforced (no unencrypted WS)
- [ ] Authentication on connect
- [ ] Authorization per message
- [ ] Input validation per message
- [ ] Rate limiting per connection
- [ ] Message size limits
- [ ] Origin validation
- [ ] Connection timeout
- [ ] Reconnection not automatic for sensitive actions

## Phase 7 — Third-Party APIs

- [ ] Outgoing HTTPS enforced
- [ ] Certificate validation (no self-signed skip)
- [ ] Timeout configured
- [ ] Retry logic with backoff
- [ ] Webhook signature verified
- [ ] Third-party data treated as untrusted
- [ ] Third-party credentials stored securely
- [ ] Third-party API key rotation
- [ ] Webhook payload validation
- [ ] IP allowlisting where possible
