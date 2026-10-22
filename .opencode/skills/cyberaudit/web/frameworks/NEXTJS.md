# ▲ NEXT.JS — SECURITY AUDIT GUIDE
# Comprehensive audit guide for Next.js applications

═══════════════════════════════════════════════════════════════
               COMPLETE NEXT.JS THREAT MODEL
═══════════════════════════════════════════════════════════════

NEXT.JS IS UNIQUE BECAUSE:
  It is both frontend AND backend in the same project.
  This duality creates context confusion risks.

  "Does this code run client-side or server-side?"
  This question is THE Next.js security question.

NEXT.JS ATTACK SURFACE
─────────────────────────

  LAYER 1 — API ROUTES (/api/*)
    Context: Server only
    Risks: Injection, auth bypass, IDOR, secret exposure

  LAYER 2 — SERVER COMPONENTS (App Router)
    Context: Server only
    Risks: SSRF, injection, secret exposure in rendering

  LAYER 3 — SERVER ACTIONS
    Context: Server (called from client)
    Risks: Auth bypass, injection, CSRF (before Next.js 14.1)

  LAYER 4 — CLIENT COMPONENTS ("use client")
    Context: Browser
    Risks: XSS, secret exposure (NEXT_PUBLIC_), 
              localStorage abuse

  LAYER 5 — getServerSideProps / getStaticProps
    Context: Server
    Risks: SSRF, injection, accidentally exposed secrets

  LAYER 6 — MIDDLEWARE (middleware.ts)
    Context: Edge Runtime
    Risks: Auth bypass, incomplete protection

  LAYER 7 — NEXT/IMAGE & NEXT/SCRIPT
    Risks: SSRF via domains, XSS via third-party scripts

═══════════════════════════════════════════════════════════════
               VULNERABLE NEXT.JS PATTERNS
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECRET EXPOSURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 1 — NEXT_PUBLIC_ with secrets
  DETECT:
    NEXT_PUBLIC_API_SECRET=sk-abc123
    NEXT_PUBLIC_DATABASE_URL=postgresql://...
    NEXT_PUBLIC_JWT_SECRET=supersecret
    NEXT_PUBLIC_STRIPE_SECRET=sk_live_...
    
    // In code:
    const secret = process.env.NEXT_PUBLIC_MY_SECRET
  
  UNDERSTAND:
    NEXT_PUBLIC_ = injected into the JavaScript bundle
    = visible in DevTools of any browser
    = in the page's HTML source
    = in the .js files downloaded by the client
  
  FIX:
    // Rule: NEXT_PUBLIC_ only for values
    //        that can be public without risk
    NEXT_PUBLIC_APP_NAME=MyApp           ✅ OK
    NEXT_PUBLIC_API_URL=https://api.x.com ✅ OK (if URL is public)
    NEXT_PUBLIC_STRIPE_PK=pk_live_...    ✅ OK (Stripe public key)
    
    // Secrets: without NEXT_PUBLIC_
    DATABASE_URL=postgresql://...         ✅ Server only
    JWT_SECRET=...                        ✅ Server only
    STRIPE_SECRET=sk_live_...             ✅ Server only
    
    // Verification in code:
    // If you use a variable without NEXT_PUBLIC_
    // in a Client Component → build error or undefined
    // This is a security feature, not a bug

CRITICAL PATTERN 2 — Secrets returned to client in Server Actions
  DETECT:
    // Server Action
    'use server'
    export async function getUserData() {
        const user = await db.user.findUnique({...})
        return user // Returns the ENTIRE user object!
    }
  
  FIX:
    'use server'
    export async function getUserData() {
        const user = await db.user.findUnique({
            where: { id: getCurrentUserId() },
            select: {
                id: true,
                name: true,
                email: true,
                // Do NOT include:
                // password, apiKey, internalNotes, etc.
            }
        })
        return user
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MIDDLEWARE AUTH BYPASS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 3 — Middleware as the only protection
  DETECT:
    // middleware.ts
    export function middleware(request: NextRequest) {
        const token = request.cookies.get('token')
        if (!token) {
            return NextResponse.redirect('/login')
        }
        // Lets through... but does NOT verify token validity!
    }
    
    // And in the API Route, no verification:
    export async function GET(request: Request) {
        // Assumes middleware already verified
        const data = await db.sensitiveData.findMany()
        return Response.json(data) // Vulnerable!
    }
  
  UNDERSTAND:
    Middleware can be bypassed via direct API access.
    Edge Runtime has limitations.
    NEVER rely solely on middleware for data security.
  
  FIX:
    // middleware.ts — First filter (UX, not security alone)
    export function middleware(request: NextRequest) {
        const token = request.cookies.get('session-token')?.value
        
        if (!token) {
            return NextResponse.redirect(new URL('/login', request.url))
        }
        
        // Pass token to handler via header
        const requestHeaders = new Headers(request.headers)
        requestHeaders.set('x-user-token', token)
        
        return NextResponse.next({ request: { headers: requestHeaders } })
    }
    
    // API Route — ALWAYS re-verify
    export async function GET(request: Request) {
        // Independent verification from middleware
        const session = await getServerSession(authOptions)
        if (!session) {
            return new Response('Unauthorized', { status: 401 })
        }
        
        // Now secure
        const data = await db.userData.findMany({
            where: { userId: session.user.id } // IDOR protection
        })
        return Response.json(data)
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SSRF VIA NEXT/IMAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 4 — Overly permissive domains in next.config.js
  DETECT:
    // next.config.js
    images: {
        domains: ['*'],                    // CRITICAL
        domains: ['**'],                   // CRITICAL
        remotePatterns: [{
            protocol: 'https',
            hostname: '**',                // CRITICAL
        }],
        remotePatterns: [{
            hostname: '**.amazonaws.com',  // Too broad
        }]
    }
  
  UNDERSTAND:
    Next.js proxies images through its server.
    An overly permissive hostname = potential SSRF
    The attacker can force the server to make requests
    to internal resources.
  
  FIX:
    images: {
        remotePatterns: [
            {
                protocol: 'https',
                hostname: 'images.yourapp.com', // Exact domain
                port: '',
                pathname: '/uploads/**',         // Limited path
            },
            {
                protocol: 'https',
                hostname: 'cdn.trusted-partner.com', // Known partner
            },
        ],
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OPEN REDIRECT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 5 — Redirect with unvalidated parameter
  DETECT:
    // API Route
    const redirectUrl = searchParams.get('next') || '/'
    return NextResponse.redirect(redirectUrl) // Vulnerable
    
    // Pages Router
    const { returnTo } = router.query
    router.push(returnTo as string) // Vulnerable
    
    // After login
    redirect(searchParams.get('callbackUrl')) // Vulnerable
  
  FIX:
    function getSafeRedirectUrl(url: string | null): string {
        if (!url) return '/'
        
        try {
            const parsed = new URL(url, 'https://yourapp.com')
            
            // Only allow URLs from our domain
            const allowedHosts = ['yourapp.com', 'www.yourapp.com']
            if (!allowedHosts.includes(parsed.hostname)) {
                return '/'
            }
            
            // Only allow known relative paths
            const allowedPaths = ['/dashboard', '/profile', '/settings']
            const pathAllowed = allowedPaths.some(p => 
                parsed.pathname.startsWith(p)
            )
            
            return pathAllowed ? parsed.pathname : '/'
        } catch {
            // Invalid URL
            return '/'
        }
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SERVER ACTIONS — CSRF AND VALIDATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 6 — Server Actions without validation or auth
  DETECT:
    'use server'
    
    export async function deleteUser(userId: string) {
        // No auth check!
        // No validation!
        await db.user.delete({ where: { id: userId } })
    }
    
    export async function updateProfile(formData: FormData) {
        // No verification that user is modifying THEIR profile
        const id = formData.get('id')
        await db.user.update({
            where: { id: id as string }, // IDOR!
            data: { name: formData.get('name') as string }
        })
    }
  
  FIX:
    'use server'
    import { auth } from '@/lib/auth'
    import { z } from 'zod'
    
    const UpdateProfileSchema = z.object({
        name: z.string().min(1).max(100),
        bio: z.string().max(500).optional(),
    })
    
    export async function updateProfile(formData: FormData) {
        // 1. Verify authentication
        const session = await auth()
        if (!session?.user?.id) {
            throw new Error('Not authenticated')
        }
        
        // 2. Validate data
        const rawData = {
            name: formData.get('name'),
            bio: formData.get('bio'),
        }
        
        const validatedData = UpdateProfileSchema.safeParse(rawData)
        if (!validatedData.success) {
            throw new Error('Invalid data')
        }
        
        // 3. Update ONLY the logged-in user's profile
        // No need for an ID provided by the client
        await db.user.update({
            where: { id: session.user.id }, // ID comes from session!
            data: validatedData.data
        })
        
        revalidatePath('/profile')
    }

═══════════════════════════════════════════════════════════════
               COMPLETE NEXT.JS CHECKLIST
═══════════════════════════════════════════════════════════════

ENVIRONMENT VARIABLES
  □ No secrets in NEXT_PUBLIC_?
  □ .env.local in .gitignore?
  □ Production variables managed via secrets manager?
  □ Env vars validated at startup?

API ROUTES & SERVER ACTIONS
  □ Auth verified independently from middleware?
  □ IDOR: ownership verified on every resource?
  □ Input validated with zod/yup/joi?
  □ Rate limiting on sensitive endpoints?
  □ HTTP methods verified? (GET ≠ POST)

MIDDLEWARE
  □ Middleware is not the only security layer?
  □ JWT token verified (signature + expiration) in middleware?
  □ Matcher configured precisely?

RENDERING
  □ dangerouslySetInnerHTML with DOMPurify if used?
  □ User data escaped in JSX?
  □ Source maps disabled in production?
    (productionBrowserSourceMaps: false in next.config)

CONFIGURATION next.config.js
  □ images.remotePatterns restrictive?
  □ headers() configured with security headers?
  □ rewrites() do not allow SSRF?
  □ CSP configured via headers()?

DEPENDENCIES
  □ next up to date (check security advisories)?
  □ next-auth/auth.js configured correctly?
  □ npm audit clean?
