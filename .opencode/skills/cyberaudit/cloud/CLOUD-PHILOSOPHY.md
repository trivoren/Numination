# ☁️ CLOUD AUDIT PHILOSOPHY — CYBERAUDIT SKILL
# The mindset for cloud configuration audit

═══════════════════════════════════════════════════════════════
                    CLOUD MENTAL MODEL
═══════════════════════════════════════════════════════════════

CLOUD = Someone else's computer that you configure with text.
Every line of IaC is a security decision.

PRINCIPLE 1 — IDENTITY IS THE NEW PERIMETER
  In cloud, network is not perimeter, IAM is.
  Ask: "Who can assume this role? With what privilege? From where?"
  Wildcard (*) = breach.

PRINCIPLE 2 — STORAGE IS PUBLIC UNTIL PROVEN PRIVATE
  Default to private. Verify:
  - ACL, bucket policy, public access block, IAM, URL signed.
  One public = data breach.

PRINCIPLE 3 — METADATA IS SECRET
  169.254.169.254 is the cloud crown jewel.
  SSRF → metadata → credentials → privilege escalation.
  Fix: IMDSv2 enforced, no SSRF, scoped IAM.

PRINCIPLE 4 — EVERYTHING IS LOGGED OR IT DIDN'T HAPPEN
  Without CloudTrail / Audit Log, you can't detect, can't respond.
  Log all control-plane + data-plane critical.

PRINCIPLE 5 — IaC IS CODE, SCAN IT
  Terraform, CloudFormation, Helm are attack surface.
  Scan with checkov/tfsec/cfn-nag in CI.

═══════════════════════════════════════════════════════════════
                    AUDIT FLOW
═══════════════════════════════════════════════════════════════

PHASE 0 — ENUMERATION
  □ Provider? AWS / GCP / Azure / multi
  □ IaC present? Terraform / CDK / SAM / Bicep / Pulumi
  □ Inventory: buckets, IAM roles/users, SG/Firewall, Lambdas, K8s
  □ Sensitive data classification (PII, financial, keys)

PHASE 1 — STORAGE AUDIT
  List all buckets/containers. For each:
  - Is it public? (check 4 layers: ACL, policy, BlockPublicAccess, IAM)
  - Encryption at rest?
  - Contains secrets? Search .env, .sql, backup.zip
  - Logging?

PHASE 2 — IAM AUDIT
  For each role/user/policy:
  - Does it have *:* ?
  - Trust policy overly permissive?
  - Access keys age?
  - MFA?
  → Craft attack path: compromised EC2/Lambda → what IAM allows?

PHASE 3 — NETWORK AUDIT
  - SG / Firewall rules 0.0.0.0/0 ?
  - Public IPs?
  - TLS version?
  - VPC architecture (public vs private)

PHASE 4 — SECRETS & COMPUTE
  - Secrets in env vars, user-data, tfvars?
  - IMDSv1 enabled?
  - Lambda public URL?

PHASE 5 — LOGGING & DETECTION
  - CloudTrail enabled + encrypted + not public?
  - Alerts on IAM/SG/bucket changes?

═══════════════════════════════════════════════════════════════
                    KILL CHAINS
═══════════════════════════════════════════════════════════════

Chain 1 — Public S3 → Data Breach
  Dev puts backup.sql in s3://app-prod-backup public.
  Attacker: s3 ls → download → credentials → full compromise.

Chain 2 — SSRF → IAM escalation
  Web app: fetch user URL without whitelist.
  Attacker: url=http://169.254.169.254/latest/meta-data/iam/security-credentials/role
  → gets temporary AWS creds → with iam:* → takeover account.

Chain 3 — Wildcard IAM → PrivEsc
  Lambda role has s3:* on *.
  Attacker compromises Lambda via injection → lists all buckets → reads secrets.

Fix: scope IAM, enforce IMDSv2, validate URLs, least privilege.
