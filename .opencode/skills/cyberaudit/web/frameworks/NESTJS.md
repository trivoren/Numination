# 🐈 NESTJS — SECURITY AUDIT GUIDE
# Comprehensive audit guide for NestJS applications

═══════════════════════════════════════════════════════════════
               NESTJS THREAT MODEL
═══════════════════════════════════════════════════════════════

NESTJS ATTACK SURFACE
─────────────────────────

  LAYER 1 — CONTROLLERS
    Risks: Endpoints without guards, poorly configured HTTP methods

  LAYER 2 — DTOs AND VALIDATION
    Risks: Missing validation, disabled whitelist,
              untyped data passed directly

  LAYER 3 — GUARDS AND INTERCEPTORS
    Risks: Incomplete guards, incorrect order,
              bypass via unprotected routes

  LAYER 4 — SERVICES AND BUSINESS LOGIC
    Risks: IDOR, authorization logic in the wrong layer

  LAYER 5 — ORM (TYPEORM / PRISMA / MONGOOSE)
    Risks: Raw queries, find() without ownership filter

  LAYER 6 — GRAPHQL (if used)
    Risks: Introspection in prod, query complexity, N+1

  LAYER 7 — MICROSERVICES
    Risks: Blind trust between internal services

═══════════════════════════════════════════════════════════════
               VULNERABLE NESTJS PATTERNS
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSUFFICIENT VALIDATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN — ValidationPipe without whitelist
  DETECT:
    // main.ts — dangerous configuration
    app.useGlobalPipes(new ValidationPipe())
    // Without whitelist: true → unknown fields pass through!

    // Incomplete DTO
    export class UpdateUserDto {
      @IsString()
      name: string
      // role, isAdmin, balance not declared BUT accepted if whitelist absent!
    }

  FIX:
    // main.ts — secure configuration
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,             // Strips undeclared fields
      forbidNonWhitelisted: true,  // Error 400 on unknown field
      transform: true,             // Transforms according to TS types
      transformOptions: {
        enableImplicitConversion: false, // Explicit conversions only
      },
      disableErrorMessages: false, // Keep messages in dev
    }))

    // Secure DTO with explicit exclusions
    export class UpdateUserDto {
      @IsOptional()
      @IsString()
      @MinLength(2)
      @MaxLength(100)
      name?: string

      @IsOptional()
      @IsString()
      @MaxLength(500)
      bio?: string

      // role, isAdmin, etc. = DO NOT DECLARE
      // With whitelist: true, these fields will be automatically stripped
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INSUFFICIENT GUARDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN — Guard applied but bypassable
  DETECT:
    // Global guard but certain routes marked public
    // without auditing those public routes

    @Controller('admin')
    export class AdminController {
      @Get('stats')
      // No guard → accessible to everyone!
      getStats() { return this.statsService.getAll() }

      @Post('users/:id/ban')
      // Guard present but only checks auth, not role
      @UseGuards(JwtAuthGuard)
      banUser(@Param('id') id: string) { ... }
    }

  FIX:
    // Global guard on the entire application
    // app.module.ts
    providers: [
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
    ]

    // Decorator for public routes (explicit whitelist)
    export const Public = () => SetMetadata('isPublic', true)

    // JwtAuthGuard respecting @Public()
    @Injectable()
    export class JwtAuthGuard extends AuthGuard('jwt') {
      constructor(private reflector: Reflector) { super() }

      canActivate(context: ExecutionContext) {
        const isPublic = this.reflector.getAllAndOverride<boolean>(
          'isPublic',
          [context.getHandler(), context.getClass()]
        )
        if (isPublic) return true
        return super.canActivate(context)
      }
    }

    // Secure admin controller
    @Controller('admin')
    @Roles('ADMIN')      // Role required on the entire controller
    export class AdminController {

      @Get('stats')
      getStats() { return this.statsService.getAll() }

      @Post('users/:id/ban')
      @Roles('SUPER_ADMIN')  // Higher role for this action
      banUser(@Param('id') id: string) { ... }
    }

    // RolesGuard
    @Injectable()
    export class RolesGuard implements CanActivate {
      constructor(private reflector: Reflector) {}

      canActivate(context: ExecutionContext): boolean {
        const requiredRoles = this.reflector.getAllAndOverride<string[]>(
          'roles',
          [context.getHandler(), context.getClass()]
        )
        if (!requiredRoles?.length) return true

        const { user } = context.switchToHttp().getRequest()
        return requiredRoles.some(role => user?.roles?.includes(role))
      }
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDOR VIA TYPEORM / PRISMA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN — findOne without ownership
  DETECT:
    // Vulnerable service
    async getDocument(id: string): Promise<Document> {
      return this.documentRepository.findOne({ where: { id } })
      // No check that the user owns this document!
    }

    // Vulnerable Prisma
    async getOrder(orderId: string) {
      return this.prisma.order.findUnique({
        where: { id: orderId }
        // No userId in the where!
      })
    }

  FIX:
    // Secure service — TypeORM
    async getDocument(
      documentId: string,
      requestingUserId: string
    ): Promise<Document> {
      const document = await this.documentRepository.findOne({
        where: {
          id: documentId,
          userId: requestingUserId, // Ownership check in the query
        }
      })

      if (!document) {
        // 404 rather than 403 to avoid enumeration
        throw new NotFoundException('Document not found')
      }

      return document
    }

    // Controller that passes userId from the token (not from body)
    @Get(':id')
    getDocument(
      @Param('id') id: string,
      @CurrentUser() user: User  // From JWT, not from body
    ) {
      return this.documentService.getDocument(id, user.id)
    }

    // @CurrentUser() Decorator
    export const CurrentUser = createParamDecorator(
      (data: unknown, ctx: ExecutionContext) => {
        const request = ctx.switchToHttp().getRequest()
        return request.user // Set by JwtAuthGuard
      }
    )

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GRAPHQL — SECURITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN — Introspection and complexity not limited
  DETECT:
    GraphQLModule.forRoot({
      autoSchemaFile: true,
      // introspection not configured → enabled by default
      // complexity not limited → DoS possible
    })

  FIX:
    import { GraphQLModule } from '@nestjs/graphql'
    import depthLimit from 'graphql-depth-limit'
    import { createComplexityLimitRule } from 'graphql-validation-complexity'

    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,

      // Disable introspection in production
      introspection: process.env.NODE_ENV !== 'production',

      // Limit query depth
      validationRules: [
        depthLimit(5),
        createComplexityLimitRule(1000, {
          onCost: (cost) => console.log('Query cost:', cost),
        }),
      ],

      // Timeout on resolvers
      context: ({ req }) => ({ req }),

      // Disable playground in production
      playground: process.env.NODE_ENV !== 'production',
    })

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TYPEORM RAW QUERIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN — Injection via query() or createQueryBuilder
  DETECT:
    // Direct injection
    await this.dataSource.query(
      `SELECT * FROM users WHERE name = '${name}'`
    )

    // Template literal in QueryBuilder
    await this.userRepository
      .createQueryBuilder('user')
      .where(`user.email = '${email}'`)
      .getOne()

  FIX:
    // dataSource.query() with parameters
    await this.dataSource.query(
      'SELECT * FROM users WHERE name = $1',
      [name]
    )

    // QueryBuilder with named parameters
    await this.userRepository
      .createQueryBuilder('user')
      .where('user.email = :email', { email })
      .andWhere('user.isActive = :active', { active: true })
      .getOne()

    // Prisma — naturally secure except $queryRaw
    // ❌ Dangerous:
    await this.prisma.$queryRaw`
      SELECT * FROM users WHERE name = ${name}
    `
    // ✅ Use Prisma.sql for parameters:
    await this.prisma.$queryRaw(
      Prisma.sql`SELECT * FROM users WHERE name = ${name}`
    )
    // Or even better, use standard Prisma methods:
    await this.prisma.user.findFirst({ where: { name } })

═══════════════════════════════════════════════════════════════
               COMPLETE NESTJS CHECKLIST
═══════════════════════════════════════════════════════════════

VALIDATION
  □ Global ValidationPipe with whitelist: true?
  □ forbidNonWhitelisted: true configured?
  □ All DTOs with validation decorators?
  □ transform: true for type conversion?

GUARDS AND AUTH
  □ Global JwtAuthGuard on the entire application?
  □ Public routes via @Public() (whitelist, not blacklist)?
  □ RolesGuard for sensitive endpoints?
  □ Guards tested with invalid/expired tokens?

AUTHORIZATION
  □ UserId always retrieved from the token (not from body/params)?
  □ Ownership verified in every resource query?
  □ NotFoundException (not ForbiddenException) to avoid enumeration?

ORM
  □ Raw queries with named parameters?
  □ Prisma $queryRaw with Prisma.sql?
  □ No interpolation in queries?

GRAPHQL (if applicable)
  □ Introspection disabled in production?
  □ Query depth limited?
  □ Query complexity limited?
  □ Playground disabled in production?

CONFIGURATION
  □ Helmet configured?
  □ CORS restrictive?
  □ Rate limiting global + sensitive endpoints?
  □ Secure compression?
