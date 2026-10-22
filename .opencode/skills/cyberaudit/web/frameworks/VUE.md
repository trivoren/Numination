# 💚 VUE.JS — SECURITY AUDIT GUIDE

═══════════════════════════════════════════════════════════════
               VUE.JS THREAT MODEL
═══════════════════════════════════════════════════════════════

VUE AUTO-ESCAPE:
  Vue automatically escapes data in templates.
  {{ userInput }} is safe by default.
  XSS risks come from exceptions to this rule.

VUE ATTACK SURFACE
──────────────────────
  LAYER 1 — TEMPLATES (v-html, :href)
    Risks: XSS via v-html, javascript: in href

  LAYER 2 — DYNAMIC COMPONENTS
    Risks: <component :is="userInput"> → XSS / injection

  LAYER 3 — SSR (Nuxt.js)
    Risks: Hydration mismatch, server-side injection

  LAYER 4 — PINIA / VUEX
    Risks: State exposure, persisted sensitive data

  LAYER 5 — VUE ROUTER
    Risks: Bypassable route guards, navigation guards

═══════════════════════════════════════════════════════════════
               VULNERABLE VUE PATTERNS
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
XSS VIA v-html
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN — v-html with user content
  DETECT:
    <div v-html="userComment"></div>
    <div v-html="product.description"></div>
    <span v-html="formattedContent"></span>

  FIX:
    // Install DOMPurify
    // npm install dompurify @types/dompurify

    // Custom Vue directive
    // directives/safe-html.ts
    import DOMPurify from 'dompurify'
    import type { Directive } from 'vue'

    export const safeHtml: Directive = {
      mounted(el, binding) {
        el.innerHTML = DOMPurify.sanitize(binding.value, {
          ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li'],
          ALLOWED_ATTR: [],
        })
      },
      updated(el, binding) {
        el.innerHTML = DOMPurify.sanitize(binding.value, {
          ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li'],
          ALLOWED_ATTR: [],
        })
      }
    }

    // Global registration
    // main.ts
    app.directive('safe-html', safeHtml)

    // Usage in templates
    <div v-safe-html="userComment"></div>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UNCONTROLLED DYNAMIC COMPONENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN — :is with user value
  DETECT:
    <component :is="userInput" />
    <component :is="route.params.componentName" />

  FIX:
    // Whitelist of allowed components
    import CardComponent from './Card.vue'
    import ListComponent from './List.vue'
    import TableComponent from './Table.vue'

    const ALLOWED_COMPONENTS = {
      card:  CardComponent,
      list:  ListComponent,
      table: TableComponent,
    } as const

    const safeComponent = computed(() => {
      return ALLOWED_COMPONENTS[userInput] || CardComponent
    })

    <component :is="safeComponent" />

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VUE ROUTER — NAVIGATION GUARDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN — Guard based on local state alone
  DETECT:
    router.beforeEach((to, from, next) => {
      const authStore = useAuthStore()
      // Based solely on Pinia state
      // No server verification
      if (to.meta.requiresAuth && !authStore.isLoggedIn) {
        next('/login')
      } else {
        next()
      }
    })

  FIX:
    router.beforeEach(async (to, from, next) => {
      if (!to.meta.requiresAuth) return next()

      try {
        // Server-side verification
        const response = await fetch('/api/auth/verify', {
          credentials: 'include'
        })

        if (!response.ok) {
          return next({
            path: '/login',
            query: { redirect: to.fullPath }
          })
        }

        const { user } = await response.json()

        // Role check if necessary
        if (to.meta.requiredRole && user.role !== to.meta.requiredRole) {
          return next('/unauthorized')
        }

        next()
      } catch {
        next('/login')
      }
    })

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NUXT.JS — SSR SPECIFIC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN — useRoute() with unvalidated params in SSR
  DETECT:
    // pages/user/[id].vue
    const route = useRoute()
    const { data } = await useFetch(`/api/user/${route.params.id}`)
    // route.params.id unvalidated = possible SSRF or injection

  FIX:
    const route = useRoute()
    const userId = route.params.id

    // Validate the ID format
    if (!/^[0-9a-f-]{36}$/.test(userId as string)) {
      throw createError({ statusCode: 400, message: 'Invalid ID' })
    }

    const { data } = await useFetch(`/api/user/${userId}`, {
      // Security headers passed if needed
    })

MEDIUM PATTERN — Secrets in nuxt.config.ts on the public side
  DETECT:
    // nuxt.config.ts
    runtimeConfig: {
      public: {
        apiSecret: process.env.API_SECRET, // EXPOSED TO CLIENT!
      }
    }

  FIX:
    runtimeConfig: {
      // Server-side only (private)
      apiSecret:    process.env.API_SECRET,
      databaseUrl:  process.env.DATABASE_URL,

      // Client-side (public) — only if truly public
      public: {
        apiUrl:     process.env.NUXT_PUBLIC_API_URL,
        appName:    'MyApp',
      }
    }

═══════════════════════════════════════════════════════════════
               COMPLETE VUE.JS CHECKLIST
═══════════════════════════════════════════════════════════════

  □ v-html with sanitization (DOMPurify)?
  □ Dynamic components with whitelist?
  □ Navigation guards with server verification?
  □ Tokens in HttpOnly cookies (not localStorage)?
  □ Nuxt: secrets in private runtimeConfig?
  □ Nuxt: useRoute() params validated server-side?
  □ Source maps disabled in production?
  □ npm audit clean?
