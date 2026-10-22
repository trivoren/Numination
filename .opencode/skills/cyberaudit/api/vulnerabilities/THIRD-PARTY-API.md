# Third-Party API Security

## The Trust Problem

Your security depends on APIs you do not control:
- Payment gateways, auth providers, SaaS integrations
- Data enrichment services, analytics, monitoring
- AI/ML APIs, cloud functions, webhooks

## Risk Categories

### 1. Data Exposure
When your app sends data to third parties:
  - Are they encrypting at rest?
  - Do they log sensitive data?
  - What happens to data on account deletion?
  - Do they sell or share data?

### 2. Supply Chain Attack
When third-party API is compromised:
  - Attacker controls responses
  - Malicious data injected downstream
  - Credential theft from third-party breach

### 3. Webhook Abuse
When third party calls your endpoint:
  - Spoofed webhook calls
  - Replay attacks
  - Payload manipulation
  - Webhook endpoint DDoS

## Remediation

### Outgoing Calls
1. Enforce HTTPS with certificate validation
2. Set timeouts on all requests
3. Implement retry logic with exponential backoff
4. Treat all external data as untrusted
5. Validate response schemas
6. Log all external calls for audit
7. Store credentials in a secrets manager

### Incoming Webhooks
1. Verify webhook signatures (HMAC)
2. Validate payload schema
3. Use a webhook secret per integration
4. Implement replay protection (timestamp + nonce)
5. Rate limit per webhook source
6. IP allowlist where possible
7. Return 200 quickly, process async

### Monitoring
1. Monitor for unusual third-party response patterns
2. Alert on third-party SLA breaches
3. Review third-party security postures regularly
4. Test third-party failure modes (graceful degradation)
5. Keep third-party dependencies minimal
