# 📦 CYBERAUDIT SKILL — INSTALLATION GUIDE
# Install the skill once, use it everywhere

═══════════════════════════════════════════════════════════════
              PREREQUISITES
═══════════════════════════════════════════════════════════════

  → Git installed on your machine
  → A compatible AI agent:
    Cursor, Windsurf, Claude, GPT, Copilot,
    or any agent that reads Markdown files
  → Zero dependency. Zero runtime. Zero compilation.

═══════════════════════════════════════════════════════════════
              INSTALLATION
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OPTION A — PROJECT-LOCAL (recommended for teams)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  The skill is versioned with your project.
  All developers get access automatically.

  # In your project root directory
  git clone https://github.com/ArisRoman/cyberaudit-skill \
    .skills/cyberaudit

  # Add to .gitignore if you don't want to commit it
  echo ".skills/" >> .gitignore

  # OR commit the skill with the project (recommended)
  git add .skills/
  git commit -m "chore: add cyberaudit security skill"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OPTION B — MACHINE-GLOBAL (recommended for solo devs)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  The skill is available across all your projects.
  Single install, universal use.

  # In your home directory
  mkdir -p ~/.skills
  git clone https://github.com/ArisRoman/cyberaudit-skill \
    ~/.skills/cyberaudit

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OPTION C — UPDATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  # Update to the latest version
  cd .skills/cyberaudit && git pull

  # Or update to a specific version
  cd .skills/cyberaudit && git checkout v2.0.0

═══════════════════════════════════════════════════════════════
              PER-AGENT CONFIGURATION
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CURSOR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Cursor automatically reads files in .cursor/rules/
  Two ways to connect the skill:

  WAY 1 — Symlink (recommended)
    # Point the skill straight to .cursor/rules/
    ln -s .skills/cyberaudit .cursor/rules/cyberaudit

  WAY 2 — Boot file copy
    # Create a Cursor rules file that loads the skill
    mkdir -p .cursor/rules
    cat > .cursor/rules/cyberaudit.mdc << 'EOF'
    ---
    description: CyberAudit Security Skill
    alwaysApply: false
    ---

    When you receive a command starting with /audit,
    load and apply the CyberAudit skill from:
    .skills/cyberaudit/

    Always start by reading:
    1. .skills/cyberaudit/COMMANDS.md
    2. .skills/cyberaudit/AGENT-BOOT.md
    3. The files defined in COMMANDS.md
       according to the command received

    You are CyberAudit, a cybersecurity expert.
    Apply the behavior defined in AGENT-BOOT.md.
    EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WINDSURF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Windsurf reads files in .windsurf/rules/

  mkdir -p .windsurf/rules
  cat > .windsurf/rules/cyberaudit.md << 'EOF'
  # CyberAudit Security Skill

  When you receive a /audit:xxx command,
  consult .skills/cyberaudit/COMMANDS.md
  to know which files to load and which
  behavior to adopt.

  Identity: .skills/cyberaudit/AGENT-BOOT.md
  Principles: .skills/cyberaudit/MASTER.md
  EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLAUDE (claude.ai or API)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  OPTION 1 — CLAUDE.md at project root
    Claude reads CLAUDE.md automatically

    cat > CLAUDE.md << 'EOF'
    # Security Skill

    This project uses the CyberAudit skill.
    When a /audit command is received,
    load files from .skills/cyberaudit/
    first consulting COMMANDS.md.
    EOF

  OPTION 2 — Via API (system prompt)
    Inject the content of AGENT-BOOT.md + COMMANDS.md
    into the system prompt of each audit session.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GITHUB COPILOT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Copilot reads .github/copilot-instructions.md

  mkdir -p .github
  cat > .github/copilot-instructions.md << 'EOF'
  # CyberAudit Security Instructions

  This project integrates the CyberAudit skill for security
  auditing. When a /audit command is detected,
  apply the rules defined in:
  .skills/cyberaudit/COMMANDS.md

  For each generated code, passively apply
  the security rules defined in:
  .skills/cyberaudit/MASTER.md
  EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANY OTHER AGENT (via API)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Read the files and inject them as system prompt:

  # Universal bash script
  BOOT=$(cat .skills/cyberaudit/AGENT-BOOT.md)
  MASTER=$(cat .skills/cyberaudit/MASTER.md)
  COMMANDS=$(cat .skills/cyberaudit/COMMANDS.md)

  SYSTEM_PROMPT="$BOOT\n\n$MASTER\n\n$COMMANDS"

  # Pass SYSTEM_PROMPT to your agent via API

═══════════════════════════════════════════════════════════════
              USAGE
═══════════════════════════════════════════════════════════════

  Once installed and configured, usage
  is immediate in your agent's chat:

  COMMAND EXAMPLES:

  Full automatic audit:
    /audit src/

  Quick scan before commit:
    /audit:quick src/controllers/UserController.php

  Specific framework audit:
    /audit:laravel app/

  Specific module:
    /audit:auth src/middleware/
    /audit:secrets .
    /audit:deps

  Mobile audit:
    /audit:react-native src/
    /audit:storage src/utils/storage.ts

  Generate report after audit:
    /audit:report
    /audit:exec

  Compliance:
    /audit:rgpd src/
    /audit:masvs src/

  See all commands:
    /audit:help

═══════════════════════════════════════════════════════════════
              CI/CD INTEGRATION
═══════════════════════════════════════════════════════════════

  GITHUB ACTIONS — Pre-merge security check

  # .github/workflows/security-audit.yml

  name: CyberAudit Security Check
  on:
    pull_request:
      branches: [main, staging]

  jobs:
    security-audit:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4

        - name: Load CyberAudit Skill
          run: |
            SKILL_CONTEXT=$(cat .skills/cyberaudit/AGENT-BOOT.md
                           .skills/cyberaudit/MASTER.md
                           .skills/cyberaudit/COMMANDS.md)
            echo "SKILL_CONTEXT<<EOF" >> $GITHUB_ENV
            echo "$SKILL_CONTEXT" >> $GITHUB_ENV
            echo "EOF" >> $GITHUB_ENV

        - name: Run Quick Audit
          # Call your AI agent via API with the skill loaded
          # and the /audit:quick command on changed files
          run: |
            echo "Quick security scan on changed files..."
            # Your API call script here

═══════════════════════════════════════════════════════════════
              UPDATES
═══════════════════════════════════════════════════════════════

  # Check installed version
  cat .skills/cyberaudit/INSTALL.md | grep "Version"

  # Update
  cd .skills/cyberaudit && git pull origin main

  # Revert to a stable version
  cd .skills/cyberaudit && git checkout v1.0.0

  # List available versions
  cd .skills/cyberaudit && git tag -l

═══════════════════════════════════════════════════════════════
              FILE STRUCTURE
═══════════════════════════════════════════════════════════════

  .skills/cyberaudit/
  ├── COMMANDS.md              ← Command router (this file)
  ├── INSTALL.md               ← This file
  ├── AGENT-BOOT.md            ← Identity and boot sequence
  ├── MASTER.md                ← Universal principles
  ├── web/                     ← All web audit
  │   ├── WEB-PHILOSOPHY.md
  │   ├── WEB-CHECKLIST.md
  │   ├── WEB-THREAT-MODELS.md
  │   ├── frameworks/          ← Laravel, Next.js, NestJS...
  │   ├── vulnerabilities/     ← SQLi, XSS, CSRF, IDOR...
  │   └── WEB-REMEDIATION-LIBRARY.md
  ├── mobile/                  ← All mobile audit
  │   ├── MOBILE-PHILOSOPHY.md
  │   ├── MOBILE-CHECKLIST.md
  │   ├── MOBILE-THREAT-MODELS.md
  │   ├── frameworks/          ← React Native, Flutter...
  │   ├── vulnerabilities/     ← Storage, Network, IPC...
  │   └── MOBILE-REMEDIATION-LIBRARY.md
  ├── shared/                  ← Shared resources
  │   ├── SEVERITY-SCORING.md
  │   ├── CVSS-GUIDE.md
  │   ├── OWASP-MAPPER.md
  │   ├── THREAT-MODELING.md
  │   └── COMPLIANCE.md
  └── reports/                 ← Report templates
      ├── REPORT-TEMPLATE-WEB.md
      ├── REPORT-TEMPLATE-MOBILE.md
      └── EXECUTIVE-SUMMARY-TEMPLATE.md

═══════════════════════════════════════════════════════════════
              SUPPORT AND CONTRIBUTION
═══════════════════════════════════════════════════════════════

  Report an issue:
    github.com/ArisRoman/cyberaudit-skill/issues

  Suggest an improvement:
    github.com/ArisRoman/cyberaudit-skill/pulls

  Add a new framework:
    Create web/frameworks/NEW-FRAMEWORK.md
    Follow LARAVEL.md structure as a template
    Add the command in COMMANDS.md
    Submit a PR

  VERSION: 3.1.5
  LICENSE: MIT
  STANDARDS: OWASP Top 10 2023 · MASVS 2.0 · CVSS 3.1 · CIS Cloud
  REPO: github.com/ArisRoman/cyberaudit-skill
