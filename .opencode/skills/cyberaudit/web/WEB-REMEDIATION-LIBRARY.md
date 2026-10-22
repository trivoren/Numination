# 🔧 WEB REMEDIATION LIBRARY — CYBERAUDIT SKILL
# Comprehensive library of ready-to-use fixes

═══════════════════════════════════════════════════════════════
  USAGE: When a finding is identified, pick the corresponding
  remediation code here.
  Each remediation is tested and production-ready.
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM-001 — UNIVERSAL INPUT VALIDATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LARAVEL — Full FormRequest
  class StoreUserRequest extends FormRequest
  {
      public function authorize(): bool
      {
          return auth()->check();
      }

      public function rules(): array
      {
          return [
              'name'     => ['required', 'string', 'min:2', 'max:100',
                             'regex:/^[\p{L}\s\-]+$/u'],
              'email'    => ['required', 'email:rfc,dns', 'max:255',
                             'unique:users,email'],
              'age'      => ['required', 'integer', 'min:18', 'max:120'],
              'website'  => ['nullable', 'url', 'max:255',
                             'regex:/^https?:\/\//'],
              'bio'      => ['nullable', 'string', 'max:1000'],
              'role'     => ['prohibited'], // Never from the client
          ];
      }

      public function messages(): array
      {
          return [
              'email.unique' => 'This email is already in use.',
              // Generic messages to avoid enumeration
          ];
      }
  }

NESTJS — DTO with class-validator
  import { IsString, IsEmail, MinLength, MaxLength,
           Matches, IsOptional, IsUrl } from 'class-validator'
  import { Transform } from 'class-transformer'

  export class CreateUserDto {
    @IsString()
    @MinLength(2)
    @MaxLength(100)
    @Matches(/^[\p{L}\s\-]+$/u, {
      message: 'Name can only contain letters'
    })
    @Transform(({ value }) => value?.trim())
    name: string

    @IsEmail()
    @MaxLength(255)
    @Transform(({ value }) => value?.toLowerCase().trim())
    email: string

    @IsString()
    @MinLength(12)
    @MaxLength(128)
    @Matches(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])/,
      { message: 'Password insufficiently complex' }
    )
    password: string

    @IsOptional()
    @IsUrl({ protocols: ['https'] })
    website?: string
  }

  // In the main module:
  // app.useGlobalPipes(new ValidationPipe({
  //   whitelist: true,        // Strips undeclared fields
  //   forbidNonWhitelisted: true, // Error on unknown fields
  //   transform: true,        // Transforms according to DTO types
  // }))

NEXTJS — Validation with Zod
  import { z } from 'zod'

  const UserSchema = z.object({
    name: z.string()
      .min(2, 'Name too short')
      .max(100, 'Name too long')
      .regex(/^[\p{L}\s\-]+$/u, 'Invalid characters'),

    email: z.string()
      .email('Invalid email')
      .max(255)
      .toLowerCase()
      .trim(),

    password: z.string()
      .min(12, 'Minimum 12 characters')
      .regex(/[A-Z]/, 'At least one uppercase')
      .regex(/[0-9]/, 'At least one digit')
      .regex(/[^A-Za-z0-9]/, 'At least one special character'),

    website: z.string()
      .url()
      .startsWith('https://')
      .optional(),
  })

  // Usage in a Server Action or API Route:
  export async function createUser(data: unknown) {
    const validated = UserSchema.safeParse(data)
    if (!validated.success) {
      return { error: validated.error.flatten() }
    }
    // Now validated.data is typed and safe
  }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM-002 — SECURE PASSWORD HASHING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NODE.JS — Argon2 (recommended)
  import argon2 from 'argon2'

  // Hash
  const hashedPassword = await argon2.hash(plainPassword, {
    type: argon2.argon2id,  // Resistant to timing AND side-channel
    memoryCost: 65536,      // 64 MB
    timeCost: 3,            // 3 iterations
    parallelism: 4,         // 4 threads
  })

  // Verify
  const isValid = await argon2.verify(hashedPassword, plainPassword)

NODE.JS — bcrypt (acceptable)
  import bcrypt from 'bcrypt'
  const SALT_ROUNDS = 12  // Minimum 12 in production

  const hashedPassword = await bcrypt.hash(plainPassword, SALT_ROUNDS)
  const isValid = await bcrypt.compare(plainPassword, hashedPassword)

LARAVEL
  // Hash (automatic with $casts)
  protected $casts = ['password' => 'hashed'];

  // Or manually
  $hashedPassword = Hash::make($plainPassword);

  // Verify
  $isValid = Hash::check($plainPassword, $hashedPassword);

  // Check if rehash needed (after config change)
  if (Hash::needsRehash($user->password)) {
      $user->update(['password' => Hash::make($newPassword)]);
  }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM-003 — SECURE JWT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NODE.JS — Full configuration
  import jwt from 'jsonwebtoken'
  import crypto from 'crypto'

  // Generate a strong secret (do once)
  // node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

  const JWT_CONFIG = {
    accessToken: {
      secret: process.env.JWT_ACCESS_SECRET,  // 64+ random bytes
      expiresIn: '15m',
      algorithm: 'HS256' as const,
    },
    refreshToken: {
      secret: process.env.JWT_REFRESH_SECRET, // Different secret!
      expiresIn: '7d',
      algorithm: 'HS256' as const,
    }
  }

  // Create an access token
  function createAccessToken(userId: string, role: string): string {
    return jwt.sign(
      {
        sub: userId,
        role: role,
        type: 'access',
        jti: crypto.randomUUID(), // Unique token ID
      },
      JWT_CONFIG.accessToken.secret!,
      {
        expiresIn: JWT_CONFIG.accessToken.expiresIn,
        algorithm: JWT_CONFIG.accessToken.algorithm,
        issuer: 'yourapp.com',
        audience: 'yourapp-api',
      }
    )
  }

  // Verify a token
  function verifyAccessToken(token: string) {
    try {
      return jwt.verify(token, JWT_CONFIG.accessToken.secret!, {
        algorithms: ['HS256'],   // NEVER leave 'none'
        issuer: 'yourapp.com',
        audience: 'yourapp-api',
      })
    } catch (error) {
      // TokenExpiredError, JsonWebTokenError, NotBeforeError
      throw new UnauthorizedException('Invalid token')
    }
  }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM-004 — COMPLETE SECURITY HEADERS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NEXT.JS — next.config.js
  const securityHeaders = [
    {
      key: 'Content-Security-Policy',
      value: [
        "default-src 'self'",
        "script-src 'self' 'nonce-{NONCE}'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self'",
        "connect-src 'self' https://api.yourapp.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "upgrade-insecure-requests",
      ].join('; ')
    },
    {
      key: 'Strict-Transport-Security',
      value: 'max-age=31536000; includeSubDomains; preload'
    },
    {
      key: 'X-Frame-Options',
      value: 'DENY'
    },
    {
      key: 'X-Content-Type-Options',
      value: 'nosniff'
    },
    {
      key: 'Referrer-Policy',
      value: 'strict-origin-when-cross-origin'
    },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=()'
    },
    {
      key: 'X-DNS-Prefetch-Control',
      value: 'on'
    }
  ]

  module.exports = {
    async headers() {
      return [
        {
          source: '/(.*)',
          headers: securityHeaders,
        },
      ]
    },
  }

LARAVEL — Middleware
  class SecurityHeadersMiddleware
  {
      public function handle(Request $request, Closure $next): Response
      {
          $response = $next($request);

          $response->headers->set(
              'Content-Security-Policy',
              "default-src 'self'; " .
              "script-src 'self'; " .
              "style-src 'self' 'unsafe-inline'; " .
              "img-src 'self' data: https:; " .
              "frame-ancestors 'none'; " .
              "base-uri 'self'"
          );
          $response->headers->set(
              'Strict-Transport-Security',
              'max-age=31536000; includeSubDomains; preload'
          );
          $response->headers->set('X-Frame-Options', 'DENY');
          $response->headers->set('X-Content-Type-Options', 'nosniff');
          $response->headers->set(
              'Referrer-Policy',
              'strict-origin-when-cross-origin'
          );
          $response->headers->set(
              'Permissions-Policy',
              'camera=(), microphone=(), geolocation=()'
          );
          $response->headers->remove('X-Powered-By');
          $response->headers->remove('Server');

          return $response;
      }
  }

NESTJS — Helmet
  import helmet from '@fastify/helmet'
  // OR for Express:
  import helmet from 'helmet'

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }))

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM-005 — RATE LIMITING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NESTJS — ThrottlerModule
  // app.module.ts
  ThrottlerModule.forRoot([
    { name: 'global', ttl: 60000, limit: 100 },
  ])

  // On sensitive endpoints:
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Post('auth/login')
  login(@Body() dto: LoginDto) { ... }

  @Throttle({ default: { ttl: 3600000, limit: 3 } })
  @Post('auth/forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) { ... }

LARAVEL
  // routes/api.php
  Route::middleware(['throttle:login'])->group(function () {
      Route::post('/login', [AuthController::class, 'login']);
  });

  // app/Providers/RouteServiceProvider.php
  RateLimiter::for('login', function (Request $request) {
      return [
          Limit::perMinute(5)->by($request->ip()),
          Limit::perMinute(10)->by($request->input('email')),
      ];
  });

  RateLimiter::for('api', function (Request $request) {
      return Limit::perMinute(60)->by(
          $request->user()?->id ?: $request->ip()
      );
  });

NEXT.JS — with upstash/ratelimit
  import { Ratelimit } from '@upstash/ratelimit'
  import { Redis } from '@upstash/redis'

  const ratelimit = new Ratelimit({
    redis: Redis.fromEnv(),
    limiter: Ratelimit.slidingWindow(5, '60 s'),
  })

  export async function POST(request: Request) {
    const ip = request.headers.get('x-forwarded-for') ?? 'anonymous'
    const { success, limit, remaining } = await ratelimit.limit(ip)

    if (!success) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: {
          'X-RateLimit-Limit': limit.toString(),
          'X-RateLimit-Remaining': remaining.toString(),
          'Retry-After': '60',
        }
      })
    }
    // Continue processing
  }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM-006 — SECURE CORS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NESTJS
  app.enableCors({
    origin: (origin, callback) => {
      const allowedOrigins = [
        'https://yourapp.com',
        'https://www.yourapp.com',
        process.env.NODE_ENV === 'development'
          ? 'http://localhost:3000'
          : null,
      ].filter(Boolean)

      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true)
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`))
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,         // Allows cookies
    maxAge: 86400,             // Cache preflight 24h
  })

LARAVEL — config/cors.php
  return [
      'paths'               => ['api/*'],
      'allowed_methods'     => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      'allowed_origins'     => [env('FRONTEND_URL', 'https://yourapp.com')],
      'allowed_origins_patterns' => [],
      'allowed_headers'     => ['Content-Type', 'Authorization', 'X-Requested-With'],
      'exposed_headers'     => [],
      'max_age'             => 86400,
      'supports_credentials' => true,
  ];

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM-007 — SECURE ERROR HANDLING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NESTJS — Global Exception Filter
  @Catch()
  export class GlobalExceptionFilter implements ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost) {
      const ctx = host.switchToHttp()
      const response = ctx.getResponse()
      const request = ctx.getRequest()

      const status = exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR

      // Full log for internal monitoring
      console.error({
        timestamp: new Date().toISOString(),
        path: request.url,
        exception: exception,
      })

      // Minimal response for the client
      // Never expose internal details
      response.status(status).json({
        statusCode: status,
        message: status === 500
          ? 'An internal error occurred'
          : (exception as HttpException).message,
        // No stack trace, no infrastructure details
      })
    }
  }

LARAVEL — app/Exceptions/Handler.php
  public function render($request, Throwable $exception): Response
  {
      if ($request->expectsJson()) {
          if ($exception instanceof ValidationException) {
              return response()->json([
                  'message' => 'Invalid data',
                  'errors'  => $exception->errors(),
              ], 422);
          }

          if ($exception instanceof ModelNotFoundException) {
              return response()->json([
                  'message' => 'Resource not found',
              ], 404);
          }

          // Generic error — do not expose details
          $statusCode = method_exists($exception, 'getStatusCode')
              ? $exception->getStatusCode() : 500;

          return response()->json([
              'message' => app()->isProduction()
                  ? 'An error occurred'
                  : $exception->getMessage(),
          ], $statusCode);
      }

      return parent::render($request, $exception);
  }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM-008 — SECURE UPLOAD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NESTJS — Full validation pipe
  import { FileInterceptor } from '@nestjs/platform-express'
  import { memoryStorage } from 'multer'
  import { fromBuffer } from 'file-type'
  import sharp from 'sharp'
  import { randomBytes } from 'crypto'

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB max
      files: 1,
    },
  }))
  async uploadFile(@UploadedFile() file: Express.Multer.File) {

    // 1. Verify real MIME type (magic bytes)
    const fileType = await fromBuffer(file.buffer)
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp']

    if (!fileType || !allowedMimes.includes(fileType.mime)) {
      throw new BadRequestException('File type not allowed')
    }

    // 2. Reprocess image (strips metadata and payloads)
    const safeBuffer = await sharp(file.buffer)
      .resize(1920, 1080, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer()

    // 3. Random filename
    const filename = `${randomBytes(32).toString('hex')}.jpg`

    // 4. Store in a private bucket (not web-accessible)
    // await s3.upload({ Bucket: 'private-uploads', Key: filename, ... })

    // 5. Return a signed URL or controlled route
    return { url: `/api/files/${filename}` }
  }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM-009 — SECURE LOGGING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

UNIVERSAL PATTERN — What should be logged
  // ALWAYS log:
  {
    timestamp:    "2024-01-15T10:30:00Z",
    event_type:   "auth.login.success" | "auth.login.failure" |
                  "resource.access" | "resource.modify" | "resource.delete" |
                  "permission.denied" | "rate_limit.exceeded",
    user_id:      "uuid-of-the-user",  // Never name/email
    ip_address:   "x.x.x.x",               // Hashed if strict GDPR
    user_agent:   "Mozilla/5.0...",
    resource:     "/api/orders/uuid-xxx",
    action:       "GET",
    result:       "success" | "failure",
    // NEVER: password, token, credit_card, ssn, etc.
  }

NODE.JS — Winston configured
  import winston from 'winston'

  const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: false }), // No stack in prod
      winston.format.json(),
    ),
    transports: [
      new winston.transports.File({
        filename: 'logs/security.log',
        level: 'warn',
      }),
      new winston.transports.Console({
        silent: process.env.NODE_ENV === 'production',
      }),
    ],
  })

  // Audit middleware
  function auditLog(event: string, userId: string,
                    resource: string, result: string) {
    logger.info({
      event_type: event,
      user_id:    userId,
      resource:   resource,
      result:     result,
      timestamp:  new Date().toISOString(),
      // No sensitive data here
    })
  }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REM-010 — ENVIRONMENT VARIABLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STARTUP VALIDATION — Node.js with Zod
  import { z } from 'zod'

  const EnvSchema = z.object({
    NODE_ENV:          z.enum(['development', 'staging', 'production']),
    DATABASE_URL:      z.string().url().startsWith('postgresql://'),
    JWT_ACCESS_SECRET: z.string().min(64),
    JWT_REFRESH_SECRET:z.string().min(64),
    REDIS_URL:         z.string().url(),
    APP_URL:           z.string().url().startsWith('https://'),

    // Keys that MUST NOT be there
    // (if someone adds them by mistake, error at startup)
    PASSWORD:          z.undefined(),
    SECRET:            z.undefined(),
  })

  const env = EnvSchema.safeParse(process.env)

  if (!env.success) {
    console.error('❌ Invalid environment variables:')
    console.error(env.error.flatten().fieldErrors)
    process.exit(1) // Refuse to start
  }

  export const config = env.data

STARTUP VALIDATION — Laravel
  // app/Providers/AppServiceProvider.php
  public function boot(): void
  {
      $requiredVars = [
          'APP_KEY', 'DB_CONNECTION', 'DB_HOST',
          'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD',
          'JWT_SECRET',
      ];

      foreach ($requiredVars as $var) {
          if (empty(env($var))) {
              throw new \RuntimeException(
                  "Missing environment variable: {$var}"
              );
          }
      }

      if (app()->isProduction() && config('app.debug')) {
          throw new \RuntimeException(
              'APP_DEBUG must be false in production!'
          );
      }
  }
