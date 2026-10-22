# 🚂 EXPRESS — SECURITY AUDIT GUIDE

═══════════════════════════════════════════════════════════════
               EXPRESS THREAT MODEL
═══════════════════════════════════════════════════════════════

EXPRESS IS MINIMALIST.
  What is a strength is also a danger.
  No default protection.
  Everything must be explicitly configured.
  An Express audit = verify that everything was added manually.

SPECIFIC EXPRESS RISKS:
  → No automatic input validation
  → No built-in auth
  → No CSRF protection by default
  → Middleware in wrong order = bypass
  → next() called after error = dangerous continuation

═══════════════════════════════════════════════════════════════
               VULNERABLE EXPRESS PATTERNS
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MIDDLEWARE ORDER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN — Auth middleware after routes
  DETECT:
    app.get('/admin/users', getUsers)  // Route before middleware!
    app.use(authMiddleware)            // Too late!

  FIX:
    // Order matters: middleware first, routes next
    app.use(helmet())
    app.use(cors(corsOptions))
    app.use(express.json({ limit: '10mb' }))
    app.use(rateLimiter)
    app.use(authMiddleware)     // Auth BEFORE protected routes

    // Public routes
    app.post('/api/auth/login', loginHandler)
    app.post('/api/auth/register', registerHandler)

    // Protected routes (after auth middleware)
    app.use('/api/admin', requireAdmin)
    app.get('/api/admin/users', getUsers)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NEXT() AFTER AN ERROR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN — Continuation after auth error
  DETECT:
    const authMiddleware = (req, res, next) => {
      const token = req.headers.authorization?.split(' ')[1]
      if (!token) {
        res.status(401).json({ error: 'No token' })
        next()  // ← CRITICAL BUG: continues despite the error!
      }
      // ...
    }

  FIX:
    const authMiddleware = (req, res, next) => {
      const token = req.headers.authorization?.split(' ')[1]

      if (!token) {
        return res.status(401).json({ error: 'Unauthorized' })
        // return → do not call next()
      }

      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET, {
          algorithms: ['HS256']
        })
        req.user = payload
        next() // Called only if auth succeeds
      } catch (error) {
        return res.status(401).json({ error: 'Invalid token' })
        // return → do not call next()
      }
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPLETE SECURE CONFIGURATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECURE EXPRESS APP
  import express from 'express'
  import helmet from 'helmet'
  import cors from 'cors'
  import rateLimit from 'express-rate-limit'
  import mongoSanitize from 'express-mongo-sanitize'
  import hpp from 'hpp'

  const app = express()

  // 1. Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
      }
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
  }))

  // 2. Remove X-Powered-By
  app.disable('x-powered-by')

  // 3. Restrictive CORS
  app.use(cors({
    origin: ['https://yourapp.com'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  }))

  // 4. Body parsing with limits
  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true, limit: '10mb' }))

  // 5. NoSQL injection sanitization
  app.use(mongoSanitize())

  // 6. HPP (HTTP Parameter Pollution) protection
  app.use(hpp())

  // 7. Global rate limiting
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, try again later' }
  }))

  // 8. Specific rate limiting on auth
  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true,
  })
  app.use('/api/auth/login', authLimiter)
  app.use('/api/auth/forgot-password', authLimiter)

  // 9. Public routes
  app.post('/api/auth/login', loginHandler)

  // 10. Auth middleware for protected routes
  app.use('/api', authMiddleware)

  // 11. Protected routes
  app.use('/api/users', userRouter)
  app.use('/api/admin', adminMiddleware, adminRouter)

  // 12. Global error handler (must be last)
  app.use((err, req, res, next) => {
    console.error(err) // Full log server-side
    res.status(err.status || 500).json({
      error: process.env.NODE_ENV === 'production'
        ? 'An error occurred'
        : err.message
    })
  })

═══════════════════════════════════════════════════════════════
               COMPLETE EXPRESS CHECKLIST
═══════════════════════════════════════════════════════════════

  □ Helmet configured first?
  □ X-Powered-By disabled?
  □ CORS with origin whitelist?
  □ Body size limited?
  □ Global + auth rate limiting?
  □ Middleware in correct order?
  □ next() never called after res.json() on error?
  □ Global error handler last?
  □ No error details exposed in prod?
  □ mongoSanitize() if MongoDB used?
  □ hpp() to prevent parameter pollution?
  □ Input validation (joi, zod, express-validator)?
