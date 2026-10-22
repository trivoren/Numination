# 🎯 MOBILE THREAT MODELS — CYBERAUDIT SKILL
# Comprehensive threat models for mobile applications

═══════════════════════════════════════════════════════════════
              STRIDE APPLIED TO MOBILE
═══════════════════════════════════════════════════════════════

S — SPOOFING
  Specific mobile threats:
  → Fake app on third-party stores (APK sideloading)
  → Certificate spoofed via compromised CA (without pinning)
  → Deep link hijacking (another app intercepts the link)
  → Intent spoofing (Android: implicit intents intercepted)
  → Biometrics bypassed via Frida hook
  
  Controls:
  → Mandatory certificate pinning
  → Explicit intents for internal communication
  → App signature verification
  → Biometrics linked to a cryptographic key

T — TAMPERING
  Specific mobile threats:
  → Binary modification APK/IPA (repackaging)
  → Hooking via Frida to modify behavior
  → Man-in-the-Middle on network traffic
  → Modification of SharedPreferences/plist files
  → Code injection via WebView bridge
  
  Controls:
  → Binary integrity verification
  → Anti-hooking / anti-Frida
  → Certificate pinning
  → Secure storage with integrity

R — REPUDIATION
  Specific mobile threats:
  → Sensitive actions without audit trail server-side
  → Transactions without cryptographic proof
  → Insufficient logs for forensic after incident
  
  Controls:
  → Server-side logging of all sensitive actions
  → Signature of critical transactions
  → Server timestamps (not client)

I — INFORMATION DISCLOSURE
  Specific mobile threats:
  → AsyncStorage/SharedPreferences read on rooted device
  → Unencrypted ADB backup
  → Screenshots in app switcher
  → Logs accessible via ADB logcat
  → Binary strings extracted from APK/IPA
  → Memory dumps on rooted device
  → Unencrypted traffic intercepted
  → Data in clipboard
  → Sensitive data in crash reports
  
  Controls:
  → Mandatory Keychain/Keystore
  → allowBackup=false or backup rules
  → Screenshot protection
  → Conditional logs in dev only
  → Secrets outside binary
  → Memory protection for sensitive data

D — DENIAL OF SERVICE
  Specific mobile threats:
  → Battery drain via excessive network requests
  → Storage exhaustion via uploads
  → CPU exhaustion via unlimited cryptographic operations
  → App crash via malformed deep link
  → Crash via malformed JSON payload in WebView bridge
  
  Controls:
  → Timeout on all network requests
  → Input validation before heavy processing
  → Server-side rate limiting
  → Exception handling on deep links

E — ELEVATION OF PRIVILEGE
  Specific mobile threats:
  → Root access exploited to read other apps' data
  → Exported Content Provider giving access to internal data
  → Exported Activity allowing access to admin functions
  → Privilege escalation via WebView → JavaScript Bridge → Native
  
  Controls:
  → Components not exported by default
  → Permissions on exported components
  → Minimal WebView bridge

═══════════════════════════════════════════════════════════════
              MOBILE ATTACK TREES
═══════════════════════════════════════════════════════════════

TREE 1 — AUTH TOKEN COMPROMISE
────────────────────────

  OBJECTIVE: Steal the authentication token
  │
  ├── VECTOR A: Extraction from storage
  │   ├── A1: Rooted device → read AsyncStorage directly
  │   │         Prerequisite: root, physical access
  │   │         Ease: EASY if AsyncStorage
  │   │
  │   ├── A2: Unencrypted ADB backup
  │   │         Prerequisite: ADB enabled OR cloud backup
  │   │         Ease: EASY if allowBackup=true
  │   │
  │   └── A3: Memory dump (app in foreground)
  │             Prerequisite: root + tools
  │             Ease: MEDIUM
  │
  ├── VECTOR B: Network interception
  │   ├── B1: MitM on public WiFi (without pinning)
  │   │         Prerequisite: same network
  │   │         Ease: EASY with mitmproxy
  │   │
  │   └── B2: Malicious CA installed (without pinning)
  │             Prerequisite: physical access to device
  │             Ease: MEDIUM
  │
  └── VECTOR C: Binary extraction
      ├── C1: Token hardcoded in JS bundle
      │         Prerequisite: APK downloaded
      │         Ease: VERY EASY
      │
      └── C2: Dev endpoint exposed in prod
                Prerequisite: knowledge of endpoint
                Ease: EASY

TREE 2 — MOBILE ACCOUNT TAKEOVER
────────────────────────────────────

  OBJECTIVE: Take control of an account
  │
  ├── VECTOR A: Session theft (see tree 1)
  │
  ├── VECTOR B: Biometrics bypass
  │   ├── B1: Frida hook on verification method
  │   │         Prerequisite: root + Frida
  │   │         Ease: EASY if client-side only check
  │   │
  │   └── B2: Biometrics = just a boolean flag
  │             Prerequisite: root or decompilation
  │             Ease: EASY if poorly implemented
  │
  ├── VECTOR C: Malicious deep link
  │   └── C1: Forged link that triggers an auth action
  │             Prerequisite: unvalidated deep link
  │             Ease: EASY
  │
  └── VECTOR D: Mobile API exploitation
      └── D1: IDOR on mobile endpoint (predictable IDs)
                Prerequisite: valid account
                Ease: MEDIUM

TREE 3 — LOCAL DATA EXFILTRATION
──────────────────────────────────────────

  OBJECTIVE: Read another user's data
  │
  ├── VECTOR A: Physical access + root
  │   └── A1: Direct read of unencrypted storage
  │             Ease: VERY EASY if unencrypted
  │
  ├── VECTOR B: Backup extraction
  │   ├── B1: ADB backup (Android)
  │   └── B2: iTunes/iCloud backup (iOS)
  │             Ease: EASY if not excluded
  │
  └── VECTOR C: Malware / malicious app
      └── C1: Intent sniffing (Android)
                Unprotected Content Provider
                Ease: MEDIUM

═══════════════════════════════════════════════════════════════
              THREAT MODELS BY MOBILE APP TYPE
═══════════════════════════════════════════════════════════════

BANKING / FINTECH APP
──────────────────────
  Priority 1: Token theft → fraudulent transactions
  Priority 2: MitM → amount manipulation
  Priority 3: Root/jailbreak → protection bypass
  Priority 4: Repackaging → fake app for phishing
  Priority 5: Screen recording during transactions
  
  Mandatory controls:
  → Certificate pinning with backup pin
  → Root/Jailbreak detection
  → Keystore with StrongBox (Android)
  → Biometrics linked to cryptographic key
  → Transaction signing server-side
  → Business code obfuscation
  → Anti-Frida/anti-debug

HEALTH APP
──────────────────────
  Priority 1: Access to other patients' medical data
  Priority 2: Cleartext data in backups
  Priority 3: Logs containing health data
  Priority 4: Data in crash reports
  Priority 5: Access without re-authentication
  
  Mandatory controls:
  → Encryption of entire local database
  → Backup exclusion
  → Crash report filtering
  → Re-auth for access to sensitive data
  → HIPAA compliance

E-COMMERCE APP
──────────────────────
  Priority 1: Card data theft (if stored)
  Priority 2: Account takeover → fraudulent purchase
  Priority 3: Client-side price manipulation
  Priority 4: Coupon/promo abuse via race condition
  Priority 5: Personal data (GDPR)
  
  Mandatory controls:
  → NEVER store card data locally
  → Use payment SDK (Stripe, etc.)
  → Server-side price validation only
  → Rate limiting on purchases

GENERAL PUBLIC APP
──────────────────────
  Priority 1: Exposed personal data
  Priority 2: Account takeover
  Priority 3: Abusive permissions
  Priority 4: Overly invasive analytics
  Priority 5: Unvalidated deep links

═══════════════════════════════════════════════════════════════
              MOBILE KILL CHAINS
═══════════════════════════════════════════════════════════════

MOBILE KILL CHAIN 1 — TOKEN THEFT VIA BACKUP
  1. Application with allowBackup="true" (Android default)
  2. Attacker with temporary physical access to device
  3. adb backup -apk com.yourapp ./backup.ab
  4. Extraction: android-backup-extractor + tar
  5. Reading: /data/data/com.yourapp/
                  shared_prefs/asyncstorage.xml
  6. Cleartext token → account access

MOBILE KILL CHAIN 2 — MITM VIA PROXY
  1. Application without certificate pinning
  2. Attacker on same WiFi network
  3. Install mitmproxy + CA on device (if user allows)
  4. Intercept all API calls
  5. Steal Bearer token from headers
  6. Replay token → account access

MOBILE KILL CHAIN 3 — BINARY SECRET EXTRACTION
  1. Download APK (from device or third-party stores)
  2. apktool d app.apk (decompilation)
  3. grep -r "API_KEY\|secret\|password\|token" ./
  4. Secrets found in cleartext in index.android.bundle
  5. Use secrets to access infrastructure

MOBILE KILL CHAIN 4 — DEEP LINK INJECTION
  1. Application with poorly validated deep link
     myapp://transfer?amount=100&to=victim
  2. Attacker creates link:
     myapp://transfer?amount=9999&to=attacker
  3. Victim clicks link (SMS, email, QR code)
  4. App opens and executes transfer without validation
  5. Money transferred to attacker's account

MOBILE KILL CHAIN 5 — FRIDA RUNTIME MANIPULATION
  1. Rooted device with Frida installed
  2. Attack on biometric verification:
     frida -U -n com.yourapp -s bypass_biometric.js
  3. Hook on verification method → always returns true
  4. Access to biometric-protected features
  5. Data extraction or execution of sensitive actions
