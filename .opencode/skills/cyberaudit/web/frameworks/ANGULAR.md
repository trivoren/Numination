# 🔴 ANGULAR — SECURITY AUDIT GUIDE

═══════════════════════════════════════════════════════════════
               ANGULAR THREAT MODEL
═══════════════════════════════════════════════════════════════

ANGULAR HAS THE MOST BUILT-IN SECURITY:
  → Auto-escape by default in templates
  → DomSanitizer for explicit bypasses
  → HttpClient with interceptors
  → Guards built into the router

BUT THESE PROTECTIONS CAN BE BYPASSED.
Looking for explicit bypasses = looking for vulnerabilities.

ANGULAR ATTACK SURFACE
──────────────────────────
  LAYER 1 — TEMPLATES AND BINDING
    Risks: bypassSecurityTrust*, innerHTML, [outerHTML]

  LAYER 2 — HTTP INTERCEPTORS
    Risks: Poorly managed tokens, unhandled errors

  LAYER 3 — ROUTE GUARDS
    Risks: Incomplete guards, insecure lazy-loading

  LAYER 4 — ENVIRONMENTS
    Risks: environment.prod with secrets

  LAYER 5 — SSR (ANGULAR UNIVERSAL)
    Risks: Server-side secrets exposed

═══════════════════════════════════════════════════════════════
               VULNERABLE ANGULAR PATTERNS
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SANITIZER BYPASS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN — bypassSecurityTrust* with user input
  DETECT:
    // ❌ Any use with user data
    this.safeHtml = this.sanitizer
      .bypassSecurityTrustHtml(userInput)

    this.safeUrl = this.sanitizer
      .bypassSecurityTrustUrl(userUrl)

    this.safeScript = this.sanitizer
      .bypassSecurityTrustScript(userScript) // CRITICAL

    // In templates:
    [innerHTML]="trustedContent"
    [outerHTML]="trustedContent"
    [href]="bypassedUrl"

  FIX:
    import DOMPurify from 'dompurify'
    import { DomSanitizer, SafeHtml } from '@angular/platform-browser'

    @Pipe({ name: 'safeHtml', standalone: true })
    export class SafeHtmlPipe implements PipeTransform {
      constructor(private sanitizer: DomSanitizer) {}

      transform(value: string): SafeHtml {
        const clean = DOMPurify.sanitize(value, {
          ALLOWED_TAGS: ['p', 'br', 'strong', 'em'],
          ALLOWED_ATTR: [],
        })
        // bypassSecurityTrustHtml ONLY after DOMPurify sanitization
        return this.sanitizer.bypassSecurityTrustHtml(clean)
      }
    }

    // Template:
    <div [innerHTML]="userContent | safeHtml"></div>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECURE HTTP INTERCEPTOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COMPLETE IMPLEMENTATION
  @Injectable()
  export class SecurityInterceptor implements HttpInterceptor {
    constructor(private authService: AuthService,
                private router: Router) {}

    intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
      // 1. Add token only to our API
      const isOwnApi = req.url.startsWith(environment.apiUrl)
      const token = this.authService.getToken()

      let secureReq = req
      if (isOwnApi && token) {
        secureReq = req.clone({
          headers: req.headers.set('Authorization', `Bearer ${token}`)
        })
      }

      return next.handle(secureReq).pipe(
        catchError((error: HttpErrorResponse) => {
          if (error.status === 401) {
            this.authService.logout()
            this.router.navigate(['/login'])
          }
          if (error.status === 403) {
            this.router.navigate(['/forbidden'])
          }
          return throwError(() => error)
        })
      )
    }
  }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANGULAR ROUTE GUARDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECURE GUARD
  export const authGuard: CanActivateFn = async (route, state) => {
    const authService = inject(AuthService)
    const router = inject(Router)

    // Server verification
    const isAuthenticated = await firstValueFrom(
      authService.checkAuthStatus()
    )

    if (!isAuthenticated) {
      return router.createUrlTree(['/login'], {
        queryParams: { returnUrl: state.url }
      })
    }

    // Role check
    const requiredRoles = route.data['roles'] as string[]
    if (requiredRoles?.length) {
      const user = authService.currentUser()
      const hasRole = requiredRoles.some(r => user?.roles.includes(r))
      if (!hasRole) {
        return router.createUrlTree(['/forbidden'])
      }
    }

    return true
  }

  // Routes
  {
    path: 'admin',
    canActivate: [authGuard],
    data: { roles: ['ADMIN'] },
    loadChildren: () => import('./admin/admin.routes')
  }

═══════════════════════════════════════════════════════════════
               COMPLETE ANGULAR CHECKLIST
═══════════════════════════════════════════════════════════════

  □ bypassSecurityTrust* only after DOMPurify?
  □ [innerHTML] never with raw user data?
  □ HttpInterceptor adding token only to our API?
  □ Route guards with server verification?
  □ environment.ts without secrets (all via API)?
  □ AOT compilation enabled (enabled by default in prod)?
  □ Source maps disabled in production?
  □ npm audit clean?
  □ Angular versions up to date?
