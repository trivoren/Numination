# API Remediation Library — CyberAudit Skill

## Authentication Fixes

### JWT Hardening
```javascript
// Secure JWT configuration
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { userId: user.id, role: user.role },
  process.env.JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '15m', issuer: 'myapp' }
);
```
- Disable 'none' algorithm
- Verify signature on every request
- Use short expiration (15-30 min)
- Implement refresh token rotation

### API Key Management
```javascript
// Hash keys before storing
const crypto = require('crypto');
const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
db.apiKeys.create({ hash, userId, scopes: ['read:orders'] });
```
- Never store raw keys in database
- Prefix keys for identification (sk_live_xxx)
- Support key rotation without downtime
- Scope keys to minimum permissions

## Authorization Fixes

### Ownership Check Middleware
```javascript
function verifyOwnership(model) {
  return async (req, res, next) => {
    const resource = await model.findById(req.params.id);
    if (!resource) return res.status(404).json({ error: 'Not found' });
    if (resource.userId !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.resource = resource;
    next();
  };
}
```

### Role-Based Access Control
```javascript
function authorize(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
// Usage: deleteUser -> authenticate, authorize('admin')
```

## Input Validation Fixes

### Schema Validation (Joi)
```javascript
const Joi = require('joi');
const schema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().required(),
  role: Joi.string().valid('user', 'admin').default('user')
});
const { error, value } = schema.validate(req.body);
if (error) return res.status(400).json({ error: error.details[0].message });
```

### SQL Injection Prevention
```javascript
// Always use parameterized queries
db.query('SELECT * FROM users WHERE id = $1', [userId]);
// Never: db.query(`SELECT * FROM users WHERE id = ${userId}`);
```

### NoSQL Injection Prevention
```javascript
// Sanitize operators before query
function sanitize(obj) {
  if (typeof obj !== 'object') return obj;
  delete obj.$where; delete obj.$ne; delete obj.$regex;
  // ... remove other dangerous operators
}
db.collection('users').find(sanitize(query));
```

## Rate Limiting Fixes

### Express Rate Limit
```javascript
const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: { error: 'Too many attempts, try again later' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/auth/login', loginLimiter);
```

## WebSocket Fixes

### Authentication on Connect
```javascript
const WebSocket = require('ws');
const server = new WebSocket.Server({ port: 8080 });
server.on('connection', (socket, req) => {
  const token = new URL(req.url, 'http://localhost').searchParams.get('token');
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = user; // Attach verified user
  } catch {
    socket.close(4001, 'Authentication failed');
  }
});
```

### Per-Message Authorization
```javascript
socket.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.action === 'deleteUser') {
    if (!socket.user.isAdmin) {
      socket.send(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    // Proceed with delete
  }
});
```

## Security Headers

```javascript
const helmet = require('helmet');
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } },
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));
app.disable('x-powered-by');
```
