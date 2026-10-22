# BOLA — Broken Object Level Authorization (API1:2023)

OWASP API Security Top 10 — #1

## Description

BOLA (also known as IDOR) occurs when an API does not verify that the requesting user is authorized to access a specific object. The attacker simply changes an object ID in the request to access another user's data.

## Detection

```javascript
// Vulnerable: no ownership check
app.get('/api/orders/:id', (req, res) => {
  const order = db.orders.findById(req.params.id);
  res.json(order);
});

// Secure: ownership check
app.get('/api/orders/:id', authenticate, (req, res) => {
  const order = db.orders.findById(req.params.id);
  if (order.userId !== req.user.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(order);
});
```

## Testing

1. Create user A and user B
2. Get A's auth token
3. Access B's resources by changing IDs
4. If successful → BOLA

## Remediation

1. Verify ownership on every object access
2. Use UUIDs instead of sequential IDs
3. Implement proper authorization middleware
4. Log all access control failures
5. Test with automated scanners
