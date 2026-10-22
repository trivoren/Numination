# 🌍 SSRF — SERVER-SIDE REQUEST FORGERY GUIDE

═══════════════════════════════════════════════════════════════
               DEFINITION
═══════════════════════════════════════════════════════════════

SSRF = The attacker forces the server to make HTTP requests
       to destinations they control, including
       internal resources normally inaccessible.

WHY IT IS CRITICAL :
  → In cloud (AWS, GCP, Azure) : access to instance metadata
    → IAM credentials → cloud account compromise
  → Access to internal services not publicly exposed
    → Redis, Elasticsearch, internal databases
  → Internal network scanning
  → Firewall bypass

OWASP : A10:2021
CWE   : CWE-918

═══════════════════════════════════════════════════════════════
               PATTERNS TO DETECT
═══════════════════════════════════════════════════════════════

SSRF ENTRY POINTS :
  → fetch(url) where url comes from user
  → axios.get(req.body.url)
  → Import of an external URL (PDF, image, file)
  → User-configured webhook
  → Content proxy
  → HTML-to-PDF conversion with URL
  → Import/export from a URL
  → Link preview (OpenGraph scraping)

VULNERABLE CODE :
  // ❌ File import from user URL
  app.post('/import', async (req, res) => {
    const { url } = req.body
    const content = await fetch(url)  // SSRF!
    await processContent(content)
  })

  // ❌ Webhook without validation
  app.post('/webhook-config', async (req, res) => {
    const { callbackUrl } = req.body
    await WebhookConfig.create({ url: callbackUrl }) // SSRF on trigger
  })

  // ❌ Image proxy
  app.get('/proxy', async (req, res) => {
    const { url } = req.query
    const response = await fetch(url) // SSRF
    response.body.pipe(res)
  })

  // ❌ HTML-to-PDF with URL
  const pdf = await htmlToPdf.create(req.body.url)

CLOUD SSRF TARGETS :
  AWS  : http://169.254.169.254/latest/meta-data/
         http://169.254.169.254/latest/meta-data/iam/security-credentials/
  GCP  : http://metadata.google.internal/computeMetadata/v1/
  Azure: http://169.254.169.254/metadata/instance

═══════════════════════════════════════════════════════════════
               REMEDIATION
═══════════════════════════════════════════════════════════════

APPROACH 1 — DOMAIN WHITELIST
  const ALLOWED_DOMAINS = new Set([
    'trusted-partner.com',
    'cdn.yourapp.com',
    'api.github.com',
  ])

  async function safeFetch(url: string): Promise<Response> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('Invalid URL')
    }

    // 1. HTTP/HTTPS protocol only
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Protocol not allowed')
    }

    // 2. Hostname in whitelist
    const hostname = parsed.hostname.toLowerCase()
    if (!ALLOWED_DOMAINS.has(hostname)) {
      throw new Error('Domain not allowed')
    }

    // 3. DNS resolution and IP verification
    const { address } = await dns.promises.lookup(hostname)
    if (isPrivateIP(address)) {
      throw new Error('Private IP not allowed')
    }

    return fetch(url, { redirect: 'error' }) // No redirects
  }

  function isPrivateIP(ip: string): boolean {
    const privateRanges = [
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^127\./,
      /^169\.254\./,  // Link-local (cloud metadata)
      /^::1$/,        // IPv6 loopback
      /^fc00:/,       // IPv6 private
      /^fe80:/,       // IPv6 link-local
    ]
    return privateRanges.some(range => range.test(ip))
  }

APPROACH 2 — NETWORK (Infrastructure)
  → Configure firewall to block outbound requests
    from the server to the internal network
  → Block access to cloud metadata endpoints
    at the network ACL level
  → Use a dedicated outbound proxy that filters destinations
