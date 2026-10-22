# ⚛️ REACT — SECURITY AUDIT GUIDE
# Comprehensive audit guide for React applications

═══════════════════════════════════════════════════════════════
               REACT THREAT MODEL
═══════════════════════════════════════════════════════════════

FUNDAMENTAL REMINDER:
  React is a FRONTEND framework.
  Backend security is still essential.
  React cannot secure data server-side.
  A React audit = audit of the client-side surface.

REACT ATTACK SURFACE
────────────────────────

  LAYER 1 — JSX RENDERING
    Risks: XSS via dangerouslySetInnerHTML, innerHTML

  LAYER 2 — STATE MANAGEMENT
    Risks: Sensitive data in Redux/Context exposed
           State logs in production

  LAYER 3 — API COMMUNICATION
    Risks: Tokens in localStorage, secrets in code,
           Client-side CORS (false security)

  LAYER 4 — CLIENT ROUTING
    Risks: Bypassable route guards, unvalidated redirect

  LAYER 5 — NPM DEPENDENCIES
    Risks: CVEs, supply chain, malicious scripts

  LAYER 6 — BUILD AND DEPLOYMENT
    Risks: Exposed source maps, env vars in bundle

═══════════════════════════════════════════════════════════════
               VULNERABLE REACT PATTERNS
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
XSS VIA DANGEROUS RENDERING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN — Unsanitized dangerouslySetInnerHTML
  DETECT:
    <div dangerouslySetInnerHTML={{ __html: userContent }} />
    <div dangerouslySetInnerHTML={{ __html: comment.body }} />
    <div dangerouslySetInnerHTML={{ __html: product.description }} />

  FIX:
    import DOMPurify from 'dompurify'

    const SafeHTML = ({ content }: { content: string }) => {
      const sanitized = DOMPurify.sanitize(content, {
        ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li'],
        ALLOWED_ATTR: [],  // No href, onclick, etc. attributes
        FORBID_TAGS: ['script', 'style', 'iframe', 'object'],
        FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
      })

      return <div dangerouslySetInnerHTML={{ __html: sanitized }} />
    }

    // Even better: use react-markdown for markdown content
    import ReactMarkdown from 'react-markdown'
    import remarkGfm from 'remark-gfm'

    const SafeMarkdown = ({ content }: { content: string }) => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Disable dangerous elements
          script: () => null,
          iframe: () => null,
          // Secure links
          a: ({ href, children }) => {
            const isExternal = href?.startsWith('http')
            return (
              <a
                href={href}
                target={isExternal ? '_blank' : undefined}
                rel={isExternal ? 'noopener noreferrer' : undefined}
              >
                {children}
              </a>
            )
          }
        }}
      >
        {content}
      </ReactMarkdown>
    )

CRITICAL PATTERN — eval() and new Function()
  DETECT:
    eval(userInput)
    eval(`return ${expression}`)
    new Function('x', userCode)()
    setTimeout(userString, 100)  // setTimeout with string!
    setInterval(userString, 100) // setInterval with string!

  FIX:
    // Never evaluate user code
    // Replace with static mappings

    // ❌ Instead of:
    const result = eval(userExpression)

    // ✅ Use a secure evaluation library
    // or a functional approach:
    const SAFE_OPERATIONS: Record<string, (a: number, b: number) => number> = {
      add:      (a, b) => a + b,
      subtract: (a, b) => a - b,
      multiply: (a, b) => a * b,
      divide:   (a, b) => b !== 0 ? a / b : 0,
    }

    const result = SAFE_OPERATIONS[operation]?.(numA, numB) ?? 0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLIENT-SIDE TOKEN STORAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN — Tokens in localStorage
  DETECT:
    localStorage.setItem('token', accessToken)
    localStorage.setItem('auth', JSON.stringify(authData))
    localStorage.getItem('token')
    sessionStorage.setItem('jwt', token)

  UNDERSTAND:
    localStorage = accessible via JavaScript
    XSS → token theft → session hijacking
    No automatic expiration
    Shared across all tabs

  FIX:
    // OPTION A — HttpOnly Cookies (recommended)
    // Token is managed server-side, not accessible via JS
    // Login via API that sets the cookie

    // React side: no token management at all
    const login = async (credentials) => {
      await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include', // Sends and receives cookies
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      })
      // HttpOnly cookie is automatically set by the server
      // React does not have access to the token
    }

    // OPTION B — Memory only (if cookies impossible)
    // Token in React memory, never in storage
    // Lost on reload → use a refresh token in cookie

    let inMemoryToken: string | null = null

    export const authService = {
      setToken: (token: string) => { inMemoryToken = token },
      getToken: () => inMemoryToken,
      clearToken: () => { inMemoryToken = null },
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECRETS IN THE BUNDLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN — Env vars in the bundle
  DETECT:
    // Everything starting with REACT_APP_ is in the bundle
    const apiKey = process.env.REACT_APP_SECRET_KEY
    const dbUrl  = process.env.REACT_APP_DATABASE_URL

  UNDERSTAND:
    REACT_APP_* = injected into the JavaScript bundle
    anyone can see these values via DevTools
    or by downloading the .js file of the app

  FIX:
    // Client-side variables (OK if truly public):
    REACT_APP_API_URL=https://api.yourapp.com      ✅
    REACT_APP_ANALYTICS_ID=G-XXXXXXXXXX            ✅
    REACT_APP_STRIPE_PUBLIC_KEY=pk_live_...        ✅

    // Secrets: NEVER in REACT_APP_
    // They must be on the server
    DATABASE_URL=...      ← Server only
    STRIPE_SECRET=...     ← Server only
    JWT_SECRET=...        ← Server only

    // If you need a server value on the client:
    // Create an API endpoint that returns the value
    // after auth verification

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLIENT ROUTE GUARDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN — Client-side only protection
  DETECT:
    // Purely client-side protection = bypassable
    const PrivateRoute = ({ children }) => {
      const token = localStorage.getItem('token')
      return token ? children : <Navigate to="/login" />
    }
    // An attacker can set token in localStorage
    // and access all "protected" components

  FIX:
    // React routes = UX only
    // Real protection = server

    // React side: verify via the server
    const PrivateRoute = ({ children }) => {
      const [isAuth, setIsAuth] = useState<boolean | null>(null)

      useEffect(() => {
        // Server-side verification, not localStorage
        fetch('/api/auth/me', { credentials: 'include' })
          .then(res => setIsAuth(res.ok))
          .catch(() => setIsAuth(false))
      }, [])

      if (isAuth === null) return <LoadingSpinner />
      if (!isAuth) return <Navigate to="/login" replace />
      return children
    }

    // AND server-side: each API route verifies auth
    // independently of React routing

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REACT ROUTER OPEN REDIRECT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MEDIUM PATTERN — Redirect with unvalidated URL parameter
  DETECT:
    const redirectTo = new URLSearchParams(location.search).get('next')
    navigate(redirectTo || '/dashboard')

    const { returnUrl } = queryParams
    window.location.href = returnUrl // CRITICAL: domain exit possible

  FIX:
    function getSafeRedirect(redirectParam: string | null): string {
      if (!redirectParam) return '/dashboard'

      // Only allow relative paths from our app
      // A relative path starts with / but not //
      if (
        redirectParam.startsWith('/') &&
        !redirectParam.startsWith('//') &&
        !redirectParam.startsWith('/\\')
      ) {
        // Verify the path is in our whitelist
        const allowedPaths = ['/dashboard', '/profile',
                              '/orders', '/settings']
        const isAllowed = allowedPaths.some(
          path => redirectParam.startsWith(path)
        )
        return isAllowed ? redirectParam : '/dashboard'
      }

      return '/dashboard'
    }

    // Usage
    const redirect = getSafeRedirect(searchParams.get('next'))
    navigate(redirect)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOURCE MAPS IN PRODUCTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MEDIUM PATTERN — Exposed source maps
  DETECT:
    // In package.json or .env:
    GENERATE_SOURCEMAP=true  (CRA default in prod)
    // .js.map files publicly accessible

  IMPACT:
    → Reconstruction of original source code
    → Business logic exposed
    → Internal file paths visible
    → Original comments and variable names readable

  FIX:
    // Create React App
    GENERATE_SOURCEMAP=false  (in .env.production)

    // Vite — vite.config.ts
    export default defineConfig({
      build: {
        sourcemap: false,  // In production
        // OR send source maps to Sentry only:
        sourcemap: true,   // Generate
        // And configure Sentry to upload them then remove
      }
    })

    // Webpack
    module.exports = {
      devtool: process.env.NODE_ENV === 'production'
        ? false           // No source maps in prod
        : 'source-map',   // Source maps in dev
    }

═══════════════════════════════════════════════════════════════
               COMPLETE REACT CHECKLIST
═══════════════════════════════════════════════════════════════

XSS AND RENDERING
  □ dangerouslySetInnerHTML with DOMPurify if used?
  □ eval() / new Function() absent?
  □ Direct innerHTML absent?
  □ External links with rel="noopener noreferrer"?
  □ CSP configured on the deployment server?

TOKEN MANAGEMENT
  □ Tokens in HttpOnly cookies (not localStorage)?
  □ No token in sessionStorage if XSS risky?
  □ Memory-only as acceptable alternative?

VARIABLES AND SECRETS
  □ No secrets in REACT_APP_?
  □ GENERATE_SOURCEMAP=false in production?
  □ .env.production in .gitignore?

ROUTING
  □ Systematic server-side protection (not just React)?
  □ Redirects validated with whitelist?
  □ URL parameters sanitized before use?

DEPENDENCIES
  □ npm audit clean?
  □ Dependencies up to date?
  □ Lock file committed?
  □ Unused dependencies removed?

API COMMUNICATION
  □ credentials: 'include' if HttpOnly cookies?
  □ HTTPS only?
  □ Error handling does not reveal internal details?
