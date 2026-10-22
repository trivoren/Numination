# 📦 SUPPLY CHAIN — VULNERABILITY GUIDE

═══════════════════════════════════════════════════════════════
               DEFINITION
═══════════════════════════════════════════════════════════════

SUPPLY CHAIN ATTACK = Compromising an application
via a third-party dependency rather than directly.

Real examples :
  → Log4Shell (CVE-2021-44228) : Log4j → RCE in thousands of apps
  → event-stream (2018) : backdoored npm package → crypto theft
  → xz utils (2024) : backdoor in a Linux compression library
  → ua-parser-js (2021) : compromised npm package → cryptominer

OWASP : A06:2021 — Vulnerable and Outdated Components
CWE   : CWE-1104

═══════════════════════════════════════════════════════════════
               ATTACK VECTORS
═══════════════════════════════════════════════════════════════

TYPOSQUATTING
  → Malicious package with a name similar to the legitimate package
  → "coIors" (capital I) instead of "colors"
  → "lodahs" instead of "lodash"
  → "crossenv" instead of "cross-env"

DEPENDENCY CONFUSION
  → Internal package named "monapp-utils"
  → Attacker publishes "monapp-utils" on public npm
  → npm installs the public version (higher version number)
  → Backdoor executed in CI/CD

PACKAGE HIJACKING
  → Developer abandons a popular package
  → Attacker takes over maintainership
  → Publishes a trojaned version

MAINTAINER ACCOUNT COMPROMISE
  → npm/PyPI maintainer account hacked
  → New version published with backdoor

MALICIOUS POSTINSTALL
  → postinstall script in a dependency's package.json
  → Executed automatically on every npm install
  → Exfiltrates secrets, installs a backdoor

═══════════════════════════════════════════════════════════════
               DEPENDENCY AUDIT
═══════════════════════════════════════════════════════════════

AUDIT COMMANDS :
  npm:
    npm audit                    # Known CVEs
    npm audit --audit-level=high # High+ only
    npx better-npm-audit audit   # Better UI
    npx npm-check-updates        # Outdated packages

  Yarn:
    yarn audit
    yarn outdated

  PNPM:
    pnpm audit

  PHP Composer:
    composer audit               # Since Composer 2.4
    # OR
    composer require --dev roave/security-advisories

  Python:
    pip-audit                    # pip install pip-audit
    safety check                 # pip install safety

WHAT TO LOOK FOR :
  □ Unfixed critical and high CVEs
  □ Unmaintained packages (last publish > 2 years, 0 downloads)
  □ Packages with suspicious postinstall scripts
  □ Packages requesting too many permissions
  □ Missing or uncommitted lock file
  □ Versions pinned with ^ or ~ (permissive)
  □ Dependencies directly from GitHub without hash

═══════════════════════════════════════════════════════════════
               REMEDIATION
═══════════════════════════════════════════════════════════════

COMMIT LOCK FILES
  # These files must be in git
  package-lock.json
  yarn.lock
  pnpm-lock.yaml
  composer.lock
  Pipfile.lock
  poetry.lock

  # They guarantee everyone installs
  # exactly the same versions

PIN VERSIONS (critical dependencies)
  # Instead of :
  "react": "^18.0.0"   # Accepts 18.x.x

  # For critical dependencies :
  "react": "18.2.0"    # Exactly this version

VERIFY POSTINSTALL SCRIPTS
  # In a dependency's package.json, look for :
  "scripts": {
    "postinstall": "node ./dist/install.js"  # What does this script do?
  }

  # npm option : disable scripts
  npm install --ignore-scripts

  # Manually check unknown packages before installation

AUDIT IN CI/CD
  # GitHub Actions
  - name: Security audit
    run: |
      npm audit --audit-level=high
      exit_code=$?
      if [ $exit_code -ne 0 ]; then
        echo "::error::Critical vulnerabilities detected"
        exit 1
      fi

PRIVATE REGISTRY
  # .npmrc to force private registry
  registry=https://registry.your-company.com
  always-auth=true

  # Prevents dependency confusion by configuring private scopes
  @company:registry=https://registry.your-company.com

ADDITIONAL TOOLS
  → Socket.dev : behavioral analysis of npm packages
  → Snyk      : dependency audit with auto-fix
  → Dependabot: automatic PRs for security updates
  → Renovate  : similar to Dependabot, more configurable
