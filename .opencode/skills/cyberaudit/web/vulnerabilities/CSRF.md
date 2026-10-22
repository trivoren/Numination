# 🎭 CSRF — CROSS-SITE REQUEST FORGERY GUIDE

═══════════════════════════════════════════════════════════════
               DEFINITION
═══════════════════════════════════════════════════════════════

CSRF = The attacker forces the victim's browser
       to send an authenticated request without their knowledge.

Prerequisites :
  → The victim is logged into the target application
  → The application uses session cookies
  → No CSRF protection in place

OWASP : A01:2021 (in Broken Access Control)
CWE   : CWE-352

ATTACK EXAMPLE :
  1. Victim is logged into bank.com
  2. Victim visits evil.com
  3. evil.com contains :
     <img src="https://bank.com/transfer?to=attacker&amount=1000">
  4. The browser sends the request with bank.com cookies
  5. Transfer made without the victim's knowledge

═══════════════════════════════════════════════════════════════
               PATTERNS TO DETECT
═══════════════════════════════════════════════════════════════

CSRF DISABLED (Laravel)
  Route::withoutMiddleware([VerifyCsrfToken::class])
       ->group(...)

  // In VerifyCsrfToken.php
  protected $except = [
      '*',  // CRITICAL : disables CSRF everywhere
      'api/*',
  ]

CSRF MISSING (API without protection)
  // API accepting mutations without CSRF token
  // AND without Origin verification
  app.post('/api/delete-account', deleteAccountHandler)

SameSite NOT CONFIGURED
  res.cookie('session', token, {
    httpOnly: true,
    secure: true,
    // SameSite missing → default depends on browser
  })

═══════════════════════════════════════════════════════════════
               REMEDIATION
═══════════════════════════════════════════════════════════════

APPROACH 1 — SAMESITE COOKIES (modern, recommended)
  res.cookie('session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',  // Or 'Lax' for incoming links
    // Strict : Cookie sent only on first-party navigation
    // Lax    : Cookie sent for links, not for sub-resources
    // None   : Sent everywhere (requires Secure=true)
  })

  // SameSite=Lax vs Strict :
  // Strict : login lost if user comes from external link
  // Lax    : Balance security/UX
  // → Recommendation : Lax for public apps, Strict for sensitive apps

APPROACH 2 — CSRF TOKEN (classic)
  LARAVEL :
    // Automatic with VerifyCsrfToken middleware
    // In Blade forms :
    <form method="POST">
      @csrf
      ...
    </form>

    // For JS API calls :
    fetch('/api/data', {
      method: 'POST',
      headers: { 'X-CSRF-TOKEN': document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] }
    })

  NODE.JS WITH CSURF (deprecated) or csrf-csrf :
    import { doubleCsrf } from 'csrf-csrf'

    const { generateToken, doubleCsrfProtection } = doubleCsrf({
      getSecret: () => process.env.CSRF_SECRET,
      cookieName: '__Host-psifi.x-csrf-token',
      cookieOptions: { sameSite: 'Strict', secure: true }
    })

    app.use(doubleCsrfProtection)

APPROACH 3 — ORIGIN VERIFICATION
  // For APIs without cookies (JWT in headers)
  // CSRF is not applicable if token is in Authorization header
  // CORS is the protection in this case

  // Verify Origin for mutations :
  app.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const origin = req.headers.origin
      const referer = req.headers.referer

      const allowedOrigins = ['https://yourapp.com']

      if (origin && !allowedOrigins.includes(origin)) {
        return res.status(403).json({ error: 'Origin not allowed' })
      }
    }
    next()
  })

WEBHOOKS — SPECIAL CASE
  // Webhooks receive POST from third-party services
  // Exclude from CSRF BUT validate HMAC signature

  // Stripe
  app.post('/webhooks/stripe',
    express.raw({ type: 'application/json' }),  // Raw body for signature
    (req, res) => {
      const sig = req.headers['stripe-signature']
      const event = stripe.webhooks.constructEvent(
        req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
      )
      // ... processing
    }
  )
