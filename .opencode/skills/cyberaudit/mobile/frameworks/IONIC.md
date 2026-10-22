# ⚡ IONIC / CAPACITOR — SECURITY AUDIT GUIDE
# Comprehensive audit guide for Ionic applications

═══════════════════════════════════════════════════════════════
              IONIC THREAT MODEL
═══════════════════════════════════════════════════════════════

IONIC IS FUNDAMENTALLY DIFFERENT
──────────────────────────────────────
  Ionic = Web Application (HTML/CSS/JS) in a native WebView.
  
  This means:
  → ALL web vulnerabilities apply
  → PLUS all mobile vulnerabilities apply
  → XSS in a WebView = access to native APIs
  → The attack surface is the LARGEST of all mobile frameworks

  [HTML/CSS/JS Angular/React/Vue]
           ↓
  [WebView (WKWebView iOS / WebView Android)]
           ↓
  [Capacitor Plugins → Native APIs]
           ↓
  [Operating System]
  
  XSS IN IONIC = POTENTIAL FILESYSTEM ACCESS

IONIC ATTACK SURFACE
────────────────────────
  LAYER 1 — WEB (everything web-related)
    XSS, CSP, mixed content, CORS
  
  LAYER 2 — WEBVIEW
    WebView configuration, local file access
  
  LAYER 3 — CAPACITOR PLUGINS
    FileSystem, Camera, Geolocation, Storage
    = native access via JavaScript calls
  
  LAYER 4 — NETWORK
    Same issues as native mobile app
  
  LAYER 5 — STORAGE
    localStorage, sessionStorage, Capacitor Storage,
    Capacitor Filesystem

═══════════════════════════════════════════════════════════════
              VULNERABLE IONIC PATTERNS
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
XSS → NATIVE ACCESS VIA CAPACITOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 1 — XSS + Capacitor = Mobile RCE
  UNDERSTAND:
    XSS in an Ionic app is not just cookie theft.
    The attacker can call Capacitor plugins:
    
    // From an XSS injection:
    Filesystem.readFile({ path: '/etc/passwd' }) → file read
    Geolocation.getCurrentPosition() → GPS tracking
    Camera.getPhoto() → camera access
    Capacitor.Plugins.SecureStorage.get('token') → token theft
  
  DETECT:
    // innerHTML without sanitisation
    element.innerHTML = userContent
    
    // Angular: [innerHTML] without DOMSanitizer
    <div [innerHTML]="userContent"></div>
    
    // Ionic with innerHtml without sanitisation
    this.content = data.userDescription // never sanitised

  FIX:
    // Angular — DOMSanitizer mandatory
    import { DomSanitizer, SafeHtml } from '@angular/platform-browser'
    
    constructor(private sanitizer: DomSanitizer) {}
    
    getSafeHtml(content: string): SafeHtml {
      // Option 1: Sanitize with Angular
      return this.sanitizer.sanitize(
        SecurityContext.HTML,
        content
      ) ?? ''
      
      // Option 2: DOMPurify (recommended)
      // npm install dompurify @types/dompurify
      return DOMPurify.sanitize(content, {
        ALLOWED_TAGS: ['p', 'b', 'i', 'br', 'strong', 'em'],
        ALLOWED_ATTR: [],
      })
    }
    
    // Template
    // <div [innerHTML]="getSafeHtml(userContent)"></div>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UNSECURE IONIC STORAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 2 — localStorage with sensitive data
  DETECT:
    localStorage.setItem('token', authToken)
    localStorage.setItem('user', JSON.stringify(user))
    sessionStorage.setItem('password', password)
    
    // Capacitor Storage (old API, unencrypted)
    import { Storage } from '@capacitor/storage'
    await Storage.set({ key: 'token', value: token })
  
  FIX:
    // npm install @capacitor/preferences
    // + encryption solution
    
    // Option: Ionic Secure Storage (encrypted, with biometrics)
    // npm install @ionic-enterprise/secure-storage
    import { SecureStorage } from '@ionic-enterprise/secure-storage'
    
    const storage = new SecureStorage()
    await storage.create()
    
    await storage.set('auth_token', token)
    const token = await storage.get('auth_token')
    await storage.remove('auth_token')
    
    // Open-source alternative:
    // npm install @aparajita/capacitor-secure-storage
    import { SecureStorage } from
      '@aparajita/capacitor-secure-storage'
    
    await SecureStorage.set('token', value, true)
    // true = requires biometrics/pin code

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTENT SECURITY POLICY IONIC
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 3 — CSP absent or too permissive
  DETECT in index.html:
    <!-- No CSP at all -->
    
    <!-- OR overly permissive CSP -->
    <meta http-equiv="Content-Security-Policy"
          content="default-src *">
    
    <!-- unsafe-inline = XSS possible -->
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'self' 'unsafe-inline'">
  
  FIX:
    <!-- index.html -->
    <meta http-equiv="Content-Security-Policy" content="
      default-src 'self';
      
      script-src 'self';
      
      style-src 'self' 'unsafe-inline';
      
      img-src 'self' data: blob: https://cdn.yourapp.com;
      
      connect-src 'self'
                  https://api.yourapp.com
                  wss://ws.yourapp.com;
      
      font-src 'self';
      
      object-src 'none';
      
      base-uri 'self';
      
      frame-ancestors 'none';
    ">
    
    <!-- Capacitor requires capacitor: scheme -->
    <!-- On iOS: gap: scheme may be needed -->
    <!-- Adapt according to specific needs -->

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UNSECURE CAPACITOR PLUGINS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 4 — Filesystem plugin without validation
  DETECT:
    import { Filesystem, Directory } from '@capacitor/filesystem'
    
    // Path built with user input
    const path = `documents/${userInput}/data.json`
    await Filesystem.readFile({ path, directory: Directory.Data })
    
    // Path traversal possible if userInput = "../../etc/passwd"
  
  FIX:
    import { Filesystem, Directory } from '@capacitor/filesystem'
    
    const safeReadFile = async (filename: string) => {
      // Whitelist of allowed filenames
      const allowedPattern = /^[a-zA-Z0-9_-]+\.json$/
      
      if (!allowedPattern.test(filename)) {
        throw new Error('Filename not allowed')
      }
      
      // No path traversal possible
      // thanks to strict pattern and Directory
      return Filesystem.readFile({
        path: filename,
        directory: Directory.Data, // Confined to app directory
        encoding: Encoding.UTF8,
      })
    }

═══════════════════════════════════════════════════════════════
              COMPLETE IONIC CHECKLIST
═══════════════════════════════════════════════════════════════

XSS AND OUTPUT
  □ DOMPurify used on all user HTML content ?
  □ Angular DomSanitizer used for [innerHTML] ?
  □ CSP configured in index.html ?
  □ CSP sufficiently restrictive (no unsafe-inline on script) ?
  □ No eval() or new Function() with user input ?

STORAGE
  □ localStorage without sensitive data ?
  □ sessionStorage without sensitive data ?
  □ Capacitor Preferences without sensitive data ?
  □ Ionic Secure Storage for tokens and secrets ?
  ↑ Data encrypted at rest ?

NETWORK
  □ HTTPS only ?
  □ Certificate pinning configured ?
  □ Tokens in headers (not localStorage → auto headers) ?

CAPACITOR PLUGINS
  □ Minimal permissions in capacitor.config.ts ?
  □ Filesystem: paths validated before use ?
  □ Camera: justified and temporary access ?
  □ Geolocation: justified and minimal access ?

BUILD
  □ Production mode: ionic build --prod ?
  □ Source maps disabled in production ?
  □ Code minified and obfuscated ?
  □ Capacitor sync performed before native build ?
