# ✅ CLOUD CHECKLIST — CYBERAUDIT SKILL
# OWASP Cloud / CIS Benchmark aligned

═══════════════════════════════════════════════════════════════
  INSTRUCTIONS: Check each item. Document ❌.
  ✅ = Conforming  ❌ = Finding  ⚠️ = Context-dependent
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 1 — STORAGE (S3, GCS, Blob)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  □ No bucket/container publicly readable (ACL: private)
  □ No bucket with public ACL + ListObjects
  □ No bucket policy with Principal: "*"
  □ Versioning enabled for critical buckets
  □ Encryption at rest (SSE-S3 / SSE-KMS / CMK)
  □ No sensitive data (keys, .env, backups) in bucket
  □ Lifecyle / retention defined, no infinite public snapshots
  □ Signed URLs with short expiry, not permanent public URLs
  □ Logging enabled (S3 access logs / CloudTrail data events)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 2 — IAM & PRIVILEGES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  □ No wildcard (*) in Action + Resource
  □ No admin (*) policies attached to app role/user
  □ Least privilege: role per service, not one god-role
  □ No long-lived access keys in repo / env / IaC
  □ Access keys rotated <90 days, unused removed
  □ MFA enforced for console, especially root/admin
  □ IAM: no password auth without MFA
  □ Service accounts / roles with trust policy restrictive
    (no sts:AssumeRole from "*")
  □ Permission boundaries in place for delegated roles

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 3 — NETWORK & SECURITY GROUPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  □ No SG 0.0.0.0/0 → 22 (SSH) or 3389 (RDP)
  □ No SG 0.0.0.0/0 → 6379 (Redis), 27017 (Mongo), 5432, 3306
  □ No SG 0.0.0.0/0 → sensitive ports (internal ALB, etc.)
  □ ALB/NLB: TLS 1.2+ only, not TLS 1.0/1.1
  □ No ELB with HTTP listener forwarding secrets
  □ VPC: private subnets for DB/cache, public only for LB
  □ Flow logs enabled
  □ No IGW route to private subnets

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 4 — SECRETS & ENV
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  □ No secrets in Terraform / CloudFormation / ARM plain
  □ Secrets stored in Secrets Manager / Parameter Store / KeyVault
  □ No .env file committed, no secret in user-data / startup-script
  □ KMS CMK used for sensitive encryption, rotation enabled
  □ No hard-coded secrets in Lambda env vars (use Secrets Manager)
  □ No API keys in frontend / mobile bundled

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 5 — LOGGING & MONITORING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  □ CloudTrail / Audit Log enabled, multi-region, encrypted
  □ No CloudTrail bucket public
  □ Alerts: root login, IAM changes, SG changes, bucket policy changes
  □ GuardDuty / Security Center / Defender for Cloud enabled
  □ Config / Policy Analyzer enabled for compliance drift

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 6 — COMPUTE (EC2, Lambda, Cloud Run)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  □ No IMDSv1 (enforce IMDSv2) → blocks SSRF → 169.254.169.254
  □ No Lambda with public Function URL without auth
  □ No EC2 with public IP + open SG + IAM god-role (SSRF pivot)
  □ Runtime updated, no EOL (Node 14, Python 3.8, etc.)
  □ No debug endpoints in prod (/debug, /console)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 7 — IaC & SUPPLY CHAIN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  □ Terraform state not public, encrypted (S3 + DynamoDB lock)
  □ No tfvars with secrets committed
  □ IaC scanned (checkov, tfsec, cfn-nag) — 0 critical
  □ Provider versions pinned, not *
  □ No public ECR/GCR images with secrets in layers

SCORE : [___ compliant items] / [___ applicable items] = ____%
