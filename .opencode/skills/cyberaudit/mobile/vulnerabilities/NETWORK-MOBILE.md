# 🌐 NETWORK MOBILE — VULNERABILITY GUIDE
# Network security for mobile applications

═══════════════════════════════════════════════════════════════
              MOBILE NETWORK THREAT MODEL
═══════════════════════════════════════════════════════════════

THE MOBILE NETWORK ENVIRONMENT IS HOSTILE BY DEFINITION
─────────────────────────────────────────────────────────
  Mobile users connect via:
  → Public WiFi (cafés, hotels, airports) → trivial MitM
  → Corporate networks with TLS inspection → MitM by design
  → 4G/5G mobile networks → harder interception
  → Personal hotspots → lower risk

  AN ATTACKER ON THE SAME NETWORK CAN:
  → See all cleartext HTTP traffic
  → Decrypt HTTPS traffic without certificate pinning
    (via malicious CA installation + proxy)
  → Inject content into HTTP responses
  → Redirect traffic to a malicious server

═══════════════════════════════════════════════════════════════
              DETAILED NETWORK VULNERABILITIES
═══════════════════════════════════════════════════════════════

VULN-NET-001 — Cleartext HTTP traffic
  Severity: CRITICAL (CVSS 8.1)
  MASVS    : MASVS-NETWORK-1
  
  Detection:
    → http:// in hardcoded URLs
    → android:usesCleartextTraffic="true"
    → NSExceptionAllowsInsecureHTTPLoads = true (iOS)
    → No Network Security Config (Android)
  
  Fix:
    Android — Network Security Config:
      <network-security-config>
        <base-config cleartextTrafficPermitted="false" />
      </network-security-config>
    
    iOS — App Transport Security:
      (Enabled by default since iOS 9, do not disable)
      Remove any NSAllowsArbitraryLoads exception

VULN-NET-002 — No Certificate Pinning
  Severity: HIGH (CVSS 7.4)
  MASVS    : MASVS-NETWORK-2
  
  Explanation:
    Without pinning, the app accepts any certificate
    signed by a trusted system CA.
    
    An attacker can:
    1. Convince the user to install a custom CA
       (social engineering, corporate MDM)
    2. Compromise a legitimate CA (rare but documented)
    3. Use a preinstalled malicious CA (rare)
    
    With a proxy (mitmproxy, Burp Suite):
    HTTPS traffic intercepted in minutes.
  
  Exploitation scenario:
    1. Attacker on same WiFi network
    2. ARP spoofing to redirect traffic
    3. mitmproxy with generated CA
    4. If no pinning: traffic decrypted in cleartext
    5. Extraction of Bearer tokens from headers

VULN-NET-003 — Certificate validation disabled
  Severity: CRITICAL (CVSS 9.1)
  MASVS    : MASVS-NETWORK-1
  
  Detection:
    // React Native — ignore SSL errors
    // (often left by mistake from development)
    fetch(url, { 
      // Some configs allow SSL bypass
    })
    
    // Flutter — badCertificateCallback always returns true
    client.badCertificateCallback = (cert, host, port) => true
    
    // Android — TrustManager that accepts everything
    TrustManager {
      override fun checkServerTrusted(...) {} // EMPTY = accepts all
    }
    
    // iOS — URLSessionDelegate
    func urlSession(..., didReceive challenge: ...) {
      completionHandler(.useCredential, ...) // Accepts all
    }
  
  Fix:
    Never disable SSL validation.
    Use certificate pinning instead.
    In development: use a properly configured
    self-signed certificate, not total bypass.

VULN-NET-004 — Sensitive data in Query Parameters
  Severity: HIGH (CVSS 7.5)
  MASVS    : MASVS-NETWORK-1
  
  Explanation:
    Query parameters appear in:
    → Server logs (access.log)
    → Proxy logs
    → Browser history (if WebView)
    → Referer headers sent to third-party services
    → Analytics and monitoring
  
  Detection:
    GET /api/users?token=eyJhbGc...
    GET /api/data?password=secret
    GET /api/reset?key=abc123
  
  Fix:
    Tokens and secrets → HTTP Authorization headers
    Sensitive data → Request body (POST)
    
    // ❌ Vulnerable
    fetch(`/api/data?token=${token}`)
    
    // ✅ Correct
    fetch('/api/data', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

VULN-NET-005 — No network timeout
  Severity: MEDIUM (CVSS 5.3)
  MASVS    : MASVS-NETWORK-1
  
  Explanation:
    Without timeout, a request can block indefinitely.
    An attacker can:
    → Make requests to a slow-responding server
    → Exhaust app resources (threads, memory)
    → Cause degraded experience
  
  Fix:
    // React Native fetch
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)
    
    try {
      const response = await fetch(url, {
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }
    
    // Axios
    axios.create({
      timeout: 10000, // 10 seconds
    })
    
    // Dio (Flutter)
    Dio(BaseOptions(
      connectTimeout: Duration(seconds: 5),
      receiveTimeout: Duration(seconds: 30),
    ))
