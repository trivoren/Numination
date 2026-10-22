# 🔑 SECRETS EXPOSURE — VULNERABILITY GUIDE

═══════════════════════════════════════════════════════════════
               DEFINITION
═══════════════════════════════════════════════════════════════

A SECRET IN CODE = a secret shared with :
  → All developers with repo access
  → GitHub/GitLab (if breach or accidental public repo)
  → CI/CD logs
  → Error messages (if displayed)
  → Source maps (if exposed)
  → Anyone who forks or clones the repo

OWASP : A02:2021 — Cryptographic Failures
CWE   : CWE-798 — Hardcoded Credentials

═══════════════════════════════════════════════════════════════
               PATTERNS TO DETECT
═══════════════════════════════════════════════════════════════

UNIVERSAL REGEX PATTERNS :
  AWS Keys      : AKIA[0-9A-Z]{16}
  AWS Secret    : aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}
  OpenAI        : sk-[A-Za-z0-9]{48}
  GitHub Token  : gh[pousr]_[A-Za-z0-9_]{36,255}
  Stripe Live   : sk_live_[0-9a-zA-Z]{24}
  Stripe Test   : sk_test_[0-9a-zA-Z]{24}
  Private Key   : -----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----
  JWT Secret    : jwt[_-]?secret\s*[:=]\s*["'][^"']{8,}
  DB URL        : (postgresql|mysql|mongodb)://[^:]+:[^@]+@
  Generic Pwd   : password\s*[:=]\s*["'][^"']{6,}

OFTEN FORGOTTEN LOCATIONS :
  → Test files (test.js, spec.php, fixtures)
  → Database seed files
  → Migration scripts
  → Example configuration files
  → Comments in code
  → Git history (git log -p | grep -i "api_key")
  → Variables in GitHub Actions
  → Variables in Dockerfiles

═══════════════════════════════════════════════════════════════
               REMEDIATION
═══════════════════════════════════════════════════════════════

STEP 1 — IMMEDIATE ROTATION (if secret exposed)
  1. Revoke the exposed secret IMMEDIATELY
  2. Generate a new secret
  3. Deploy with the new secret
  4. Check logs for unauthorized access
  5. Inform stakeholders if necessary

STEP 2 — REMOVE FROM CODE
  // Remove from current code
  // But beware : it remains in git history!

STEP 3 — PURGE GIT HISTORY
  # Use BFG Repo Cleaner (simpler than git-filter-branch)
  # Installation : brew install bfg

  # Delete an entire file
  bfg --delete-files .env

  # Replace a specific value
  echo "sk-abc123...==>REMOVED" > replacements.txt
  bfg --replace-text replacements.txt

  # Finalize
  git reflog expire --expire=now --all
  git gc --prune=now --aggressive
  git push origin --force --all

  # WARNING : Notify the entire team to re-clone

STEP 4 — PREVENTION
  # .gitignore
  .env
  .env.local
  .env.*.local
  .env.production
  *.key
  *.pem
  secrets.json
  config/secrets.yml

  # Pre-commit hook with detect-secrets
  pip install detect-secrets
  detect-secrets scan > .secrets.baseline
  # In .pre-commit-config.yaml :
  # - repo: https://github.com/Yelp/detect-secrets
  #   hooks:
  #     - id: detect-secrets

  # GitHub : enable Secret Scanning in settings
  # GitLab : enable Secret Detection in CI

STEP 5 — SECRET MANAGER
  SOLUTIONS :
  → HashiCorp Vault (self-hosted, very comprehensive)
  → AWS Secrets Manager (if on AWS)
  → Google Secret Manager (if on GCP)
  → Azure Key Vault (if on Azure)
  → Infisical (open-source, easy)
  → Doppler (SaaS, simple)

  // Example with Infisical (Node.js)
  import { InfisicalClient } from '@infisical/sdk'

  const client = new InfisicalClient({
    token: process.env.INFISICAL_TOKEN,
  })

  const { secretValue: dbPassword } = await client.getSecret({
    environment: 'production',
    projectId: process.env.INFISICAL_PROJECT_ID,
    secretName: 'DB_PASSWORD',
  })
