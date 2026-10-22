# 🌐 CORS — CROSS-ORIGIN RESOURCE SHARING GUIDE

═══════════════════════════════════════════════════════════════
               UNDERSTANDING CORS
═══════════════════════════════════════════════════════════════

SOP (Same-Origin Policy) = Browser protection
  By default, the browser blocks cross-origin requests.
  CORS is a mechanism to selectively RELAX SOP.

Misconfigured CORS = Useless SOP

CORS CONCERNS :
  → JS fetch/axios requests from the browser
  → Not curl, Postman, or server-to-server requests
  → Only what the browser enforces

SO : CORS is protection against browser attacks
       NOT against direct server-side calls

═══════════════════════════════════════════════════════════════
               DANGEROUS PATTERNS
═══════════════════════════════════════════════════════════════

CRITICAL PATTERN — Wildcard with credentials
  DETECT :
    Access-Control-Allow-Origin: *
    Access-Control-Allow-Credentials: true

  IMPACT :
    Any site can make authenticated requests
    Session data theft, actions on behalf of the user

  NOTE : Modern browsers refuse * + credentials
         But some custom configs allow it

CRITICAL PATTERN — Origin reflection without validation
  DETECT :
    // Bad "dynamic" implementation
    const origin = req.headers.origin
    res.setHeader('Access-Control-Allow-Origin', origin) // Reflect everything!
    res.setHeader('Access-Control-Allow-Credentials', 'true')

  IMPACT :
    Any origin is accepted → equivalent to *
    But with credentials → even worse than *

HIGH PATTERN — null origin accepted
  DETECT :
    if (origin === 'null' || allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
    }

  IMPACT :
    Local files (file://) and sandboxed iframes
    send Origin: null → access granted

HIGH PATTERN — Overly broad subdomains
  DETECT :
    // Poorly written regex
    if (origin.endsWith('.yourapp.com')) {
      // evil.yourapp.com.attacker.com → passes!
    }

    // Better but still risky if subdomains compromised :
    if (origin.match(/\.yourapp\.com$/)) {
      // An XSS'd subdomain compromises everything
    }

═══════════════════════════════════════════════════════════════
               CORS REMEDIATION
═══════════════════════════════════════════════════════════════

COMPLETE SECURE CONFIGURATION
  const ALLOWED_ORIGINS = new Set([
    'https://yourapp.com',
    'https://www.yourapp.com',
    'https://admin.yourapp.com',
    ...(process.env.NODE_ENV === 'development'
      ? ['http://localhost:3000', 'http://localhost:3001']
      : [])
  ])

  function corsMiddleware(req, res, next) {
    const origin = req.headers.origin

    if (!origin) {
      // Request without Origin (curl, Postman, server-to-server)
      // Allow but without CORS header
      return next()
    }

    if (ALLOWED_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Allow-Methods',
        'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Requested-With')
      res.setHeader('Access-Control-Max-Age', '86400') // Cache preflight

      if (req.method === 'OPTIONS') {
        return res.status(204).end()
      }
    } else {
      // Silently reject (no CORS header)
      // The browser will block the request
    }

    next()
  }

  // Vary header important for caches
  app.use((req, res, next) => {
    res.setHeader('Vary', 'Origin')
    next()
  })
