# ✅ MASTER CHECKLIST WEB — CYBERAUDIT SKILL
# The ultimate checklist — Never skip a line

═══════════════════════════════════════════════════════════════
  INSTRUCTIONS: Check each item. Document every ❌.
  A ❌ = a potential finding to investigate.
  A ⚠️ = context-dependent, investigate and justify.
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 1 — SECRETS AND CONFIGURATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ No API key in source code
  □ No password in source code
  □ No private key in source code
  □ No token in source code
  □ No secret in comments
  □ No secret in test files
  □ No .env file committed in git
  □ .env in .gitignore (check the file)
  □ Environment variables validated at startup
  □ Debug/development mode disabled in prod
  □ Error handling does not reveal stack trace in prod
  □ Headers revealing technology removed
    (X-Powered-By, Server, X-AspNet-Version)
  □ Version information not publicly exposed
  □ Debug/info endpoints disabled in prod
    (/phpinfo, /debug, /.env, /server-status, etc.)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 2 — AUTHENTICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ Passwords hashed with bcrypt/argon2/scrypt
  □ MD5, SHA1, SHA256 (without salt) never used for passwords
  □ Unique salt per password
  □ Strong password policy (minimum length)
  □ Rate limiting on login attempts
  □ Lockout after N failures (or CAPTCHA)
  □ JWT: verify() used (not decode())
  □ JWT: algorithm explicitly specified
  □ JWT: algorithm "none" refused
  □ JWT: expiration configured (access ≤ 15min)
  □ JWT: refresh tokens with rotation
  □ JWT: revocation possible (blacklist or rotation)
  □ Sessions: cryptographically random ID
  □ Sessions: regeneration after login
  □ Sessions: invalidation on logout
  □ Sessions: inactivity expiration configured
  □ Reset password: random and unique token
  □ Reset password: short expiration (15-30min)
  □ Reset password: single-use token
  □ Reset password: message not revealing account existence
  □ OAuth: state parameter validated (anti-CSRF)
  □ OAuth: redirect_uri strictly validated
  □ MFA: available on sensitive accounts
  □ Default credentials nonexistent

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 3 — AUTHORIZATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ Auth verification server-side on EVERY endpoint
  □ Public routes explicitly defined (whitelist)
  □ RBAC implemented and verified server-side
  □ Ownership verified for every resource access
    (Can the user access THIS object?)
  □ Predictable IDs avoided (UUIDs or opaque IDs)
  □ Mass assignment: whitelist of allowed fields
  □ Sensitive fields excluded from mass updates
    (role, is_admin, balance, verified, etc.)
  □ Admin function access verified, not just hidden
  □ Privilege elevation via parameter impossible
  □ Pagination: server-side limit enforced

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 4 — INJECTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ SQL queries: only parameterized or ORM
  □ No variable interpolation in SQL queries
  □ NoSQL queries: injection operators impossible
  □ OS commands: exec/system with user input absent
  □ Templates: user input not injected into engines
  □ File paths: confined to allowed directory
  □ Uploaded filenames: regenerated randomly
  □ XML: external entities disabled
  □ GraphQL: introspection disabled in prod
  □ GraphQL: query depth and complexity limited
  □ Logs: log injection impossible (newlines filtered)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 5 — XSS AND OUTPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ All HTML output encoded/escaped
  □ Direct innerHTML absent (or sanitized)
  □ dangerouslySetInnerHTML with DOMPurify if used
  □ Blade {!! !!} with HTMLPurifier if used
  □ URLs in href validated (not javascript:)
  □ Correct Content-Type on all responses
  □ JSON: Content-Type: application/json (not text/html)
  □ CSP configured and restrictive
  □ X-Content-Type-Options: nosniff present

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 6 — CSRF AND CLICKJACKING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ CSRF tokens on all POST forms
  □ CSRF verification server-side
  □ SameSite=Strict or Lax on session cookies
  □ Webhooks: HMAC signature verified
  □ X-Frame-Options or CSP frame-ancestors configured
  □ Destructive actions require explicit confirmation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 7 — SECURITY HEADERS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ Content-Security-Policy configured
  □ Strict-Transport-Security configured (HSTS)
    (max-age=31536000; includeSubDomains; preload)
  □ X-Frame-Options: DENY or SAMEORIGIN
  □ X-Content-Type-Options: nosniff
  □ Referrer-Policy configured
  □ Permissions-Policy configured
  □ Cache-Control: no-store on sensitive data
  □ HTTPS only (no HTTP downgrade possible)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 8 — CORS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ Access-Control-Allow-Origin: * absent on authenticated APIs
  □ CORS origins whitelisted explicitly
  □ credentials: true never combined with origin: *
  □ CORS methods limited to necessary
  □ CORS headers limited to necessary
  □ Preflight properly handled

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 9 — FILE UPLOAD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ MIME type verified server-side (not just extension)
  □ Whitelist of allowed extensions
  □ Maximum size enforced
  □ Filename regenerated randomly
  □ Files stored outside webroot
  □ Code execution impossible in upload folder
  □ Antivirus scan on uploads (if critical)
  □ Image resize/recompress to strip metadata

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 10 — DEPENDENCIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ npm audit / yarn audit / composer audit: clean?
  □ No critical or high CVE unaddressed
  □ Lock files committed (package-lock.json, yarn.lock, composer.lock)
  □ Direct dependencies only from npm/packagist
  □ Main framework up to date (or close)
  □ Abandoned dependencies identified and replaced

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 11 — RATE LIMITING & DOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ Global rate limiting configured
  □ Specific rate limiting on: login, register, reset-password
  □ Rate limiting on expensive endpoints (upload, export, search)
  □ Pagination: page size limited server-side
  □ Timeouts configured on outgoing requests
  □ Body size limited (no infinite upload in memory)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 12 — LOGGING AND MONITORING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ Auth events logged (login, logout, failures)
  □ Sensitive actions logged (deletion, role modification)
  □ Logs do not contain sensitive data
    (no passwords, tokens, card numbers in logs)
  □ Logs structured (JSON) and centralized
  □ Alerts configured on suspicious events
  □ Logs integrity-protected (append-only or SIEM)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 13 — SSRF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ No HTTP request based on a user-provided URL
    without strict validation
  □ If URL fetch necessary: whitelist of allowed domains
  □ Access to cloud metadata blocked
    (169.254.169.254, fd00:ec2::254)
  □ Access to internal network (10.x, 172.x, 192.168.x) blocked
  □ Redirect following: limited and validated
  □ DNS rebinding: protections in place

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 14 — CRYPTOGRAPHY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ Modern algorithms only:
    Encryption    : AES-256-GCM, ChaCha20-Poly1305
    Data hashing  : SHA-256 minimum
    Password hash : bcrypt, argon2, scrypt
    Asymmetric    : RSA-2048+, ECDSA P-256+
  □ DES, 3DES, RC4, MD5, SHA1 absent
  □ Encryption keys stored separately from data
  □ Unique IV/Nonce per encryption
  □ Cryptographically secure random generation
    (crypto.randomBytes, openssl_random_pseudo_bytes)
  □ Sensitive data encrypted in database
  □ Encryption keys rotated regularly

═══════════════════════════════════════════════════════════════
SCORE : [___ compliant items] / [___ applicable items] = ____%
═══════════════════════════════════════════════════════════════
