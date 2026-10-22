# API AUDIT PHILOSOPHY — CyberAudit Skill
# The mindset of an API security expert

## The API Mental DNA

An API is not a website with less HTML.
It is a bare attack surface, no interface,
no friction, accessible by machines
that can send thousands of requests per second.

When you audit an API, think like
an attacker who read the entire documentation
AND is looking for what the documentation does not say.

Modern APIs have three unique characteristics
that make them particularly dangerous:

  1. THEY TRUST BY DESIGN
     An API is built to be consumed.
     Its nature is to accept requests.
     The challenge: distinguish legitimate requests
     from malicious ones.

  2. THEY EXPOSE BUSINESS LOGIC DIRECTLY
     No UI to hide functionality.
     Every endpoint is an exposed business function.
     An attacker reading your docs sees your architecture.

  3. THEY ARE DESIGNED FOR AUTOMATION
     What is a feature for developers
     is a weapon for attackers.
     A script can test 10,000 IDs in 10 seconds.

## The 8 Truths of API Security

TRUTH 1 — THE OBJECT IS THE ATTACK UNIT
  On the web, you attack pages.
  On an API, you attack objects.
  GET /users/1 → GET /users/2 → GET /users/3...
  IDOR is the #1 vulnerability in APIs.
  Every endpoint with an ID is an attack vector.

TRUTH 2 — AUTHENTICATION ≠ AUTHORIZATION
  An API can perfectly authenticate a user
  and still give them access to everyone else's data.
  Valid token ≠ authorized access to this resource.

TRUTH 3 — EVERYTHING IS AN INPUT
  Headers, query params, body, cookies, files.
  An API trusts what it receives.
  Validation must happen at every boundary.

TRUTH 4 — RATE LIMITING IS SECURITY
  Without rate limiting, an API is defenseless.
  Brute force, enumeration, DDoS — all prevented
  by a simple rate limit.

TRUTH 5 — THE DOCUMENTATION IS AN ATTACK PLAN
  Your OpenAPI spec tells attackers exactly
  where to look. Every endpoint described
  is an endpoint tested.

TRUTH 6 — INTERNAL APIS ARE NOT SAFE
  "Internal only" means no WAF, no rate limiting,
  no auth, no monitoring. Internal APIs are
  the most vulnerable.

TRUTH 7 — LEGACY ENDPOINTS ARE BACKDOORS
  /v1/users, /api/old/orders, deprecated routes
  that were forgotten. They still work.
  They have weaker security.

TRUTH 8 — THIRD-PARTY APIS ARE YOUR LIABILITY
  The API you consume can be compromised.
  The API you expose can be abused by partners.
  Trust must be verified, not assumed.

## The API Audit Flow

PHASE 0 — DISCOVERY & MAPPING
  □ List ALL endpoints (documented + undocumented)
  □ Identify auth mechanisms per endpoint
  □ Map data types and sensitivity
  □ Find shadow APIs and deprecated endpoints
  □ Test every HTTP method on every endpoint

PHASE 1 — AUTHENTICATION
  □ Token handling (JWT, OAuth, API keys)
  □ Token validation on every endpoint
  □ Token expiration and rotation
  □ Weak authentication mechanisms

PHASE 2 — AUTHORIZATION
  □ IDOR/BOLA on every object access
  □ BFLA on every admin function
  □ Mass assignment protection
  □ Role-based access control verification

PHASE 3 — INPUT VALIDATION
  □ Injection testing on all inputs
  □ Parameter pollution
  □ Content-type validation
  □ Schema validation bypass

PHASE 4 — RATE LIMITING & ABUSE
  □ Brute force protection
  □ Enumeration prevention
  □ Pagination abuse
  □ Resource exhaustion

PHASE 5 — DATA EXPOSURE
  □ Over-fetching in responses
  □ Sensitive data in error messages
  □ Excessive data in list endpoints
  □ Debug endpoints exposed

PHASE 6 — CONFIGURATION
  □ CORS misconfiguration
  □ TLS/SSL verification
  □ Security headers
  □ Debug mode disabled
