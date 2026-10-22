# 🛡️ SECURITY HEADERS — VULNERABILITY GUIDE

═══════════════════════════════════════════════════════════════
               ESSENTIAL SECURITY HEADERS
═══════════════════════════════════════════════════════════════

EACH MISSING HEADER = MISSING PROTECTION

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTENT-SECURITY-POLICY (CSP)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ROLE    : Controls authorized sources for each resource type
  PROTECTS : XSS, script injection, clickjacking, data exfiltration
  MISSING  : XSS can execute arbitrary code

  CHECK :
    □ Present on all HTML pages
    □ Restrictive default-src
    □ unsafe-inline absent from script-src
    □ unsafe-eval absent from script-src
    □ frame-ancestors configured
    □ base-uri configured (prevents base tag injection)
    □ form-action configured

  TEST : https://csp-evaluator.withgoogle.com/

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT-TRANSPORT-SECURITY (HSTS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ROLE    : Forces the browser to use HTTPS only
  PROTECTS : SSL stripping, downgrade attacks
  MISSING  : HTTP connection possible → MitM

  RECOMMENDED VALUE :
    Strict-Transport-Security: max-age=31536000; includeSubDomains; preload

  CHECK :
    □ max-age ≥ 31536000 (1 year)
    □ includeSubDomains if all subdomains are HTTPS
    □ preload to be in browser HSTS list
    □ Server on HTTPS (otherwise this header is ignored)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
X-FRAME-OPTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ROLE    : Prevents loading in an iframe
  PROTECTS : Clickjacking
  MISSING  : The app can be loaded in a malicious iframe

  RECOMMENDED VALUE :
    X-Frame-Options: DENY
    // OR if embedding needed :
    X-Frame-Options: SAMEORIGIN

  NOTE : Replaced by CSP frame-ancestors but X-Frame-Options
         is still supported by older browsers

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
X-CONTENT-TYPE-OPTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ROLE    : Prevents MIME sniffing
  PROTECTS : Malicious file upload served as HTML/JS
  MISSING  : Uploaded file interpreted with wrong MIME type

  SINGLE VALUE :
    X-Content-Type-Options: nosniff

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REFERRER-POLICY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ROLE    : Controls info sent in the Referer header
  PROTECTS : Sensitive URL leakage (tokens in URL, internal paths)

  RECOMMENDED VALUE :
    Referrer-Policy: strict-origin-when-cross-origin
    // Sends : origin only for cross-origin, full URL for same-origin

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PERMISSIONS-POLICY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ROLE    : Controls available browser APIs
  PROTECTS : Unauthorized access to camera, mic, geolocation

  RECOMMENDED VALUE :
    Permissions-Policy: camera=(), microphone=(), geolocation=(),
                        payment=(), usb=(), bluetooth=()
    // Disable everything the app does not use

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HEADERS TO REMOVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  X-Powered-By     → Reveals Express, PHP version, etc.
  Server           → Reveals nginx/apache version
  X-AspNet-Version → Reveals .NET version
  X-AspNetMvc-Version

  This info helps an attacker target specific CVEs.

═══════════════════════════════════════════════════════════════
               TEST TOOL
═══════════════════════════════════════════════════════════════

  → https://securityheaders.com/
  → https://observatory.mozilla.org/
  → curl -I https://yourapp.com
