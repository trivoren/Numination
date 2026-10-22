# 🌐 WEB AUDIT PHILOSOPHY — CYBERAUDIT SKILL
# The mindset of a web security expert

═══════════════════════════════════════════════════════════════
                    THE WEB MENTAL DNA
═══════════════════════════════════════════════════════════════

When you look at a web application, you don't see code.
You see a TRUST NETWORK with boundaries.

Each boundary is a question:
  "Who decided this data is safe here?"
  "Who verifies that this action is authorized?"
  "Who guarantees that this secret stays secret?"

If the answer is "nobody" or "we assume" → VULNERABILITY

═══════════════════════════════════════════════════════════════
                    THE 7 DEADLY SINS OF THE WEB
═══════════════════════════════════════════════════════════════

SIN 1 — TRUSTING INPUT
  Data coming from outside is always hostile.
  "But it's a client-side validated email field"
  → The client can be anyone with Burp Suite
  → ALWAYS validate server-side. Always. Without exception.

SIN 2 — CONFUSING AUTHENTICATION AND AUTHORIZATION
  Authenticated = I know who you are
  Authorized = I verified you can do this
  
  A logged-in user accessing another user's data = IDOR = mortal sin

SIN 3 — PUTTING SECRETS IN CODE
  Every secret in code is offered to:
  → Every developer on the team
  → Anyone with repo access (GitHub breach?)
  → CI/CD logs
  → Error messages
  → Source maps

SIN 4 — TRUSTING THE FRONTEND
  The frontend is a billboard.
  Anyone can modify it.
  Any security logic on the client side = no security.
  
  "The button is disabled" → F12 → button enabled
  "We hide the ID in base64" → atob() → ID visible
  "We check the role in JS" → console → role changed

SIN 5 — NEGLECTING DEPENDENCIES
  You don't write 100% of your code.
  Log4Shell was in a dependency.
  The code you didn't write can be the most dangerous.

SIN 6 — DEPLOYING IN DEBUG
  A debug mode in production offers:
  → Full stack traces (infrastructure mapping)
  → Exposed environment variables
  → Active debug routes
  → Verbose logs with sensitive data

SIN 7 — IGNORING HEADERS
  Security headers are a free shield.
  Not configuring them = leaving a door open
  for no good reason.

═══════════════════════════════════════════════════════════════
                    THE AUDIT FLOW
═══════════════════════════════════════════════════════════════

PHASE 0 — RECONNAISSANCE AND CONTEXT
══════════════════════════════════════
  
  QUESTIONS TO ASK:
  
  □ What is the main framework? Its version?
  □ Is there a frontend separate from the backend?
  □ What types of data are processed?
    (PII? Financial? Health? National security?)
  □ Who are the users?
    (Anonymous public? Authenticated users? Admins?)
  □ What are the most critical endpoints?
  □ Are there third-party integrations?
    (Payment, OAuth, external APIs?)
  □ What is the target environment?
    (Local dev? Staging? Production?)
  
  ATTACK SURFACE MAPPING:
  
  → List ALL entry points:
    - HTTP routes (GET/POST/PUT/PATCH/DELETE)
    - WebSockets
    - GraphQL queries/mutations
    - Incoming webhooks
    - File uploads
    - Import/Export features
    - Background jobs (if triggerable)
  
  → Identify high-value areas:
    - Authentication endpoints
    - Payment endpoints
    - Administration endpoints
    - Personal data endpoints
    - File endpoints

PHASE 1 — SECRETS AND CONFIGURATION AUDIT
══════════════════════════════════════════
  
  ABSOLUTE PRIORITY — Done first, always.
  An exposed secret = possible immediate compromise.
  
  SCAN FOR:
  
  □ API Keys in source code (all files)
  □ Hardcoded passwords
  □ Private RSA/EC keys
  □ JWT secret tokens
  □ Connection strings with credentials
  □ Encryption keys
  □ Webhook secrets
  □ NEXT_PUBLIC_ containing secrets
  □ Variables in comments
  □ Secrets in test files
  □ Git history (deleted but present secrets)
  □ Committed .env files
  □ Config files with production values
  
  CHECK CONFIGURATION:
  
  □ Debug mode disabled in production?
  □ Error handling does not reveal infrastructure?
  □ Logging configured not to log secrets?
  □ CORS configured restrictively?
  □ Rate limiting in place?
  □ Security headers present?

PHASE 2 — AUTHENTICATION AUDIT
══════════════════════════════════
  
  ANALYSIS FLOW:
  
  STEP 2.1 — Authentication mechanism
  □ How are credentials verified?
  □ Password hashing: bcrypt/argon2 or MD5/SHA1?
  □ Salt used?
  □ Timing attacks possible in comparison?
  
  STEP 2.2 — Sessions and Tokens
  □ JWT: algorithm configured? (reject "none")
  □ JWT: expiration configured? (15min access, 7d refresh)
  □ JWT: signature verified with verify() not decode()?
  □ JWT: secret long and random enough?
  □ Sessions: cryptographically random ID?
  □ Sessions: invalidation on logout?
  □ Sessions: regeneration after login?
  □ Refresh tokens: rotation implemented?
  □ Refresh tokens: revocation possible?
  
  STEP 2.3 — Password reset process
  □ Reset token: random and unique?
  □ Reset token: short expiration? (15-30min max)
  □ Reset token: single-use?
  □ User enumeration possible via message?
  □ Reset link: HTTPS only?
  
  STEP 2.4 — Brute force protection
  □ Rate limiting on login?
  □ Lockout after N attempts?
  □ CAPTCHA present if necessary?
  □ Alerts on suspicious attempts?
  
  STEP 2.5 — MFA
  □ MFA available?
  □ MFA bypassable? (poorly secured recovery codes?)
  □ TOTP properly implemented?
  □ Backup codes stored securely?

PHASE 3 — AUTHORIZATION AUDIT
══════════════════════════════
  
  ANALYSIS FLOW:
  
  STEP 3.1 — Authorization model
  □ RBAC implemented?
  □ Authorization check server-side on EVERY endpoint?
  □ Auth middleware applied globally or per route?
  □ Public routes explicitly defined or by default?
  
  STEP 3.2 — IDOR/BOLA (Object Level Authorization)
  □ Each object access checks ownership?
    EXAMPLE: GET /api/orders/:id → verify the order
              belongs to the logged-in user
  □ Are IDs predictable? (1, 2, 3...)
  □ UUIDs used instead of sequential IDs?
  □ Indirect access verified? (A accesses B which contains C)
  
  STEP 3.3 — BFLA (Function Level Authorization)
  □ Admin routes protected by role check?
  □ Admin actions verified and not just hidden?
  □ Privilege elevation possible via parameter?
    EXAMPLE: POST /user/update with { "role": "admin" }
  
  STEP 3.4 — Mass Assignment
  □ Whitelist of accepted fields defined?
  □ Sensitive fields excluded from mass updates?
    (role, is_admin, verified, balance...)

PHASE 4 — INJECTION AUDIT
══════════════════════════
  
  FOR EACH ENTRY POINT IDENTIFIED IN PHASE 0:
  
  □ SQL Injection
    → Parameterized queries used?
    → ORM used? If yes, raw queries avoided?
    → Input passed directly into a query?
  
  □ NoSQL Injection
    → MongoDB: $where, $regex operators with user input?
    → Redis: commands built with user input?
  
  □ Command Injection
    → exec(), system(), shell_exec() with user input?
    → Shell libraries with unsanitized parameters?
  
  □ SSTI (Server-Side Template Injection)
    → User input inserted into templates?
    → Engines: Twig, Jinja2, Blade, Handlebars, EJS?
  
  □ Path Traversal
    → File paths built with user input?
    → Upload: filename validated?
    → File read: path confined to allowed directory?
  
  □ XSS (Cross-Site Scripting)
    → Output encoded/escaped before display?
    → dangerouslySetInnerHTML without sanitization?
    → Direct innerHTML?
    → CSP configured?
    → Correct Content-Type headers?
  
  □ XXE (XML External Entities)
    → XML parsing: external entities disabled?
    → XML/SVG upload accepted?
  
  □ GraphQL
    → Introspection disabled in production?
    → Query depth limited?
    → Query complexity limited?
    → Rate limiting on queries?

PHASE 5 — CRYPTOGRAPHY AND DATA AUDIT
══════════════════════════════════════════
  
  □ Sensitive data encrypted in database?
  □ Encryption keys stored separately from data?
  □ Modern algorithms used?
    (AES-256-GCM, ChaCha20-Poly1305, not DES/RC4)
  □ Passwords hashed with bcrypt/argon2/scrypt?
  □ Data in transit: HTTPS only?
  □ Recent TLS version? (1.2 minimum, 1.3 recommended)
  □ Certificates valid and up to date?
  □ HSTS configured?
  □ Sensitive data in URLs? (logs expose them)
  □ Sensitive data in logs?
  □ PII: minimal collection?
  □ PII: limited retention?

PHASE 6 — DEPENDENCIES AUDIT
═════════════════════════════
  
  □ npm audit / yarn audit: critical/high CVEs?
  □ composer audit: same
  □ Framework versions: known CVEs?
  □ Abandoned or unmaintained packages?
  □ Lock files committed? (avoids dependency confusion)
  □ Post-install scripts in dependencies?
  □ Dependencies directly from GitHub?
    (risk of commit modification)
  □ Packages with names similar to known packages?
    (typosquatting)

PHASE 7 — INFRASTRUCTURE AND HEADERS AUDIT
═══════════════════════════════════════════
  
  MANDATORY SECURITY HEADERS:
  □ Content-Security-Policy (CSP)
  □ Strict-Transport-Security (HSTS)
  □ X-Frame-Options or CSP frame-ancestors
  □ X-Content-Type-Options: nosniff
  □ Referrer-Policy
  □ Permissions-Policy
  □ Cache-Control on sensitive data
  
  HEADERS TO REMOVE:
  □ X-Powered-By (reveals the framework)
  □ Server (reveals the web server)
  □ X-AspNet-Version
  
  CONFIGURATION:
  □ CORS: origins explicitly whitelisted?
  □ CORS: credentials: true with * forbidden?
  □ Rate limiting: global + per sensitive endpoint?
  □ File upload: MIME type verified server-side?
  □ File upload: size limited?
  □ File upload: stored outside webroot?
  □ Pagination: server-side limits enforced?
