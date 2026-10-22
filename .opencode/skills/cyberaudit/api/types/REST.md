# REST API — Security Audit Guide

## Threat Model

REST APIs are resource-oriented. Each endpoint maps to a CRUD operation on a resource. The attack surface is every URL + method combination.

## Vulnerability Patterns

### CRITICAL — IDOR/BOLA
Every resource access must verify ownership.
```
GET /api/orders/1     → verify order belongs to user
PUT /api/users/2/role → verify admin + ownership
```
Test: replace IDs sequentially, check access.

### CRITICAL — Mass Assignment
Extra fields in request body modify protected attributes.
```
POST /api/users
{ "name": "test", "role": "admin" }  ← role should be ignored
```
Fix: whitelist allowed fields server-side.

### CRITICAL — Injection in Parameters
URL params, query strings, headers all carry injection risk.
```
GET /api/users?search=' OR 1=1 --
GET /api/users?sort=email; DROP TABLE users --
```
Fix: parameterized queries, input validation.

### HIGH — Authentication Bypass
```
GET /api/admin/users            ← 401 Unauthorized
GET /api/admin/users?role=admin  ← 200 OK (bypass via param)
```
Fix: auth middleware on route groups, not individual handlers.

### HIGH — Improper Asset Management
Deprecated endpoints still active:
```
GET /api/v1/users  (current)
GET /api/v0/users  (old, no auth)
```
Fix: decommission old versions, redirect with 410.

### MEDIUM — Excessive Data Exposure
```
GET /api/users returns:
{ "id": 1, "name": "John", "ssn": "123-45-6789", "password_hash": "$2a$..." }
```
Fix: Response DTOs, exclude sensitive fields.

### MEDIUM — Rate Limiting Absent
Without rate limiting:
- Brute force login: 1000 tries/min
- Enumeration: scan all user IDs
- DoS: flood expensive endpoints

Fix: rate limiting per user/IP/token.

## REST-Specific Best Practices

1. Use proper HTTP methods (GET read, POST create, PUT full update, PATCH partial)
2. Return proper status codes (401 unauth, 403 forbidden, 429 rate limit)
3. Validate Content-Type header (reject unexpected formats)
4. Never expose internal IDs in URLs if sequential
5. Use HATEOAS links carefully (don't leak endpoints)
6. Version your API properly (URL or header based)
7. Document all endpoints (but don't include security details)
