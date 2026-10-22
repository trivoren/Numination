# BOPLA — Broken Function Level Authorization (API2:2023)

OWASP API Security Top 10 — #2

## Description

BOPLA occurs when an API exposes administrative or privileged functions that regular users can access. The attacker uses a regular user token to call admin endpoints.

## Detection

```javascript
// Vulnerable: no admin check
app.delete('/api/admin/users/:id', authenticate, (req, res) => {
  db.users.delete(req.params.id);
  res.status(204).send();
});

// Secure: role check
app.delete('/api/admin/users/:id', authenticate, authorize('admin'), (req, res) => {
  db.users.delete(req.params.id);
  res.status(204).send();
});
```

## Testing

1. Create a regular user and an admin user
2. Get regular user token
3. Try all admin endpoints with regular token
4. If any succeed → BOPLA

## Remediation

1. Implement role-based access control
2. Verify authorization on every admin function
3. Never rely on route-level auth alone
4. Use function-level authorization decorators/middleware
5. Test with least-privilege tokens
