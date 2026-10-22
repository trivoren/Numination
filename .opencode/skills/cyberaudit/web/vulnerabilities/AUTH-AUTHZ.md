# 🔐 AUTH & AUTHZ — VULNERABILITY GUIDE

═══════════════════════════════════════════════════════════════
               AUTHENTICATION VS AUTHORIZATION
═══════════════════════════════════════════════════════════════

AUTHENTICATION = "Who are you?"
  Verify a user's identity.
  Mechanisms : Password, MFA, Biometrics, SSO, OAuth

AUTHORIZATION = "Do you have permission?"
  Verify if the authenticated user can perform this action.
  Mechanisms : RBAC, ABAC, ACL, Policy-based

BOTH CAN BE COMPROMISED INDEPENDENTLY.
  Strong Auth + Weak Authz = IDOR, privilege escalation
  Weak Auth + Strong Authz = account takeover then escalation

OWASP : A07:2021 (Auth) + A01:2021 (Authz)

═══════════════════════════════════════════════════════════════
               AUTHENTICATION FLAWS
═══════════════════════════════════════════════════════════════

BRUTE FORCE
  Detect : No rate limiting on /login
  Impact   : Account compromise with weak passwords
  Fix : Rate limiting + lockout + CAPTCHA + increasing delay

CREDENTIAL STUFFING
  Detect : Same accounts as on other services
  Impact   : Mass compromise if passwords reused
  Fix : Mandatory MFA + credential stuffing detection
             (HaveIBeenPwned API, delays, device fingerprinting)

PASSWORD RESET HIJACKING
  Detect :
    - Predictable token (timestamp, MD5 hash of email)
    - No token expiration
    - Reusable token
    - Message revealing if email exists
  Impact   : Full account takeover
  Fix :
    const resetToken = crypto.randomBytes(32).toString('hex')
    const hashedToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex')

    await db.passwordReset.create({
      data: {
        userId:    user.id,
        token:     hashedToken,  // Store hash, send raw
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15min
        used:      false,
      }
    })

SESSION FIXATION
  Detect : Session ID not regenerated after login
  Impact   : Attacker forces a known session ID, then user logs in
  Fix : req.session.regenerate() after every authentication

JWT VULNERABILITIES
  Detect :
    - "none" algorithm accepted
    - jwt.decode() instead of jwt.verify()
    - Short or predictable secret
    - No expiration
    - Algorithm confusion (RS256 → HS256 with public key)
  Impact   : Forged token = identity theft
  Fix : See REM-003 in remediation library

═══════════════════════════════════════════════════════════════
               AUTHORIZATION FLAWS
═══════════════════════════════════════════════════════════════

IDOR (Insecure Direct Object Reference)
  See : web/vulnerabilities/IDOR-BOLA.md

BFLA (Broken Function Level Authorization)
  Detect :
    - Admin endpoints accessible without role check
    - Destructive actions without verification
    - Unrestricted HTTP methods (DELETE without auth)
  Impact   : Access to admin functions by a normal user
  Fix :
    // Role verification on EVERY admin endpoint
    @Get('admin/users')
    @Roles('ADMIN', 'SUPER_ADMIN')
    async getUsers() { ... }

    // Do not rely on the URL starting with /admin
    // Verify role explicitly even under /admin

PRIVILEGE ESCALATION
  Detect :
    - "role" field accepted in user updates
    - is_admin parameter in body
    - JWT with modifiable role on client side
  Impact   : Normal user becomes admin
  Fix :
    // Never update role from user input
    // Except through an explicitly protected admin endpoint

    // ❌ DANGEROUS :
    await user.update(req.body) // req.body may contain role: "admin"

    // ✅ SECURE :
    await user.update({
      name:    req.body.name,
      email:   req.body.email,
      // role → never from req.body
    })

MASS ASSIGNMENT
  See : web/frameworks/LARAVEL.md (Pattern 5 and 6)
