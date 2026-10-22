# ✅ MOBILE MASTER CHECKLIST — CYBERAUDIT SKILL
# The ultimate mobile checklist — OWASP MASVS 2.0 aligned

═══════════════════════════════════════════════════════════════
  INSTRUCTIONS: Check each item. Document each ❌.
  ✅ = Conforming   ❌ = Finding   ⚠️ = Context-dependent   N/A = Not applicable
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 1 — LOCAL STORAGE (MASVS-STORAGE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SENSITIVE DATA
  □ No auth token in AsyncStorage / SharedPreferences
  □ No password in AsyncStorage / SharedPreferences
  □ No PII data in cleartext in insecure storage
  □ No financial data in cleartext on the device
  □ Keychain (iOS) used for secrets on iOS
  □ Keystore (Android) used for secrets on Android
  □ react-native-keychain / flutter_secure_storage used
  □ AccessControl configured on Keychain
    (BIOMETRY_ANY_OR_DEVICE_PASSCODE minimum)
  □ Accessible configured on Keychain
    (WHEN_UNLOCKED_THIS_DEVICE_ONLY recommended)

LOCAL DATABASE
  □ SQLite encrypted if sensitive data (SQLCipher)
  □ Hive encrypted if sensitive data (Flutter)
  □ Realm encrypted if sensitive data
  □ DB encryption key stored in Keychain/Keystore
  □ Encryption key not hardcoded in code

LOCAL FILES
  □ Sensitive files in app's private directory
  □ Sensitive files excluded from backups
    Android: android:allowBackup="false" or rules
    iOS    : NSURLIsExcludedFromBackupKey = true
  □ PDFs / sensitive documents encrypted before storage
  □ Sensitive images not accessible from gallery
  ↑ HTTP cache containing no sensitive data

LOGS AND DEBUGGING
  □ No token in logs (console.log, print, NSLog)
  □ No password in logs
  □ No PII data in logs
  □ Debug logs disabled in production
  □ __DEV__ / BuildConfig.DEBUG used to condition logs
  □ Sentry/Crashlytics: sensitive data filtered before sending

USER INTERFACE
  □ Password fields with secureTextEntry={true}
  □ Autocomplete disabled on sensitive fields
  □ Keyboard cache disabled on sensitive fields
    (autoComplete="off", textContentType="oneTimeCode")
  □ Clipboard not exposed for sensitive data
  □ Screenshot disabled or screen hidden in background
    Android: FLAG_SECURE
    iOS    : overlay when backgrounding
  □ Sensitive data hidden in app switcher

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 2 — NETWORK (MASVS-NETWORK)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HTTPS AND TLS
  □ HTTPS used exclusively (no http://)
  □ Android: usesCleartextTraffic="false"
  □ Android: Network Security Config configured
  □ iOS: App Transport Security without unjustified exceptions
  □ TLS 1.2 minimum, TLS 1.3 recommended
  □ Weak cipher suites disabled
  □ Valid and non-expired certificates
  □ Certificate validation not disabled
    (Never ignore SSL errors in prod)

CERTIFICATE PINNING
  □ Certificate pinning implemented on critical endpoints
  □ At least 2 pins configured (1 primary + 1 backup)
  □ Pin expiration date configured
  □ Rotation procedure documented
  □ Library used: react-native-ssl-pinning / dio pinning
  □ Pinning on auth and sensitive data endpoints

NETWORK REQUESTS
  □ Auth tokens in headers (Authorization: Bearer)
  □ Auth tokens never in query parameters
  □ Timeout configured on all requests
  □ Retry logic with exponential backoff
  □ Sensitive data not logged in interceptors
  □ Security headers verified client-side if necessary

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 3 — CRYPTOGRAPHY (MASVS-CRYPTO)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ALGORITHMS
  □ AES-256-GCM or ChaCha20-Poly1305 for symmetric encryption
  □ RSA-2048+ or ECDSA P-256+ for asymmetric encryption
  □ SHA-256 minimum for hashing (not MD5, not SHA1)
  □ bcrypt / argon2 for passwords if stored locally
  □ No custom algorithm implemented
  □ Standard cryptographic libraries used
    (libsodium, CryptoKit, javax.crypto)

KEYS AND SECRETS
  □ No cryptographic key hardcoded in code
  □ No keys in resource files
  □ Keys generated with a secure random generator
  □ Keys stored in Keychain/Keystore
  □ Unique IV/Nonce per encryption operation
  □ Session keys different from encryption keys

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 4 — AUTHENTICATION (MASVS-AUTH)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TOKENS AND SESSIONS
  □ Access tokens stored in Keychain/Keystore
  □ Refresh tokens stored in Keychain/Keystore
  □ Short access token expiration (≤ 15 min)
  □ Refresh token rotation implemented
  □ Token revocation server-side possible
  □ Tokens invalidated on logout
  □ Tokens invalidated on password change

BIOMETRICS
  □ Biometrics linked to a cryptographic key (not just UI check)
  □ invalidatedByBiometricEnrollment = true (Android)
  □ Secure fallback if biometrics unavailable
  □ Biometrics require device unlock
  □ No bypass possible via ADB or basic Frida

SESSION
  □ Inactivity timeout configured
  □ Re-authentication required for sensitive actions
  □ Session invalidated if app is uninstalled
  □ Correct jailbreak/root behavior documented

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 5 — PLATFORM (MASVS-PLATFORM)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ANDROID — COMPONENTS
  □ Unnecessary Activities: android:exported="false"
  □ Unnecessary Services: android:exported="false"
  □ Unnecessary Broadcast Receivers: exported="false"
  □ Unnecessary Content Providers: exported="false"
  □ Permissions required on exported components
  □ Minimal and precise intent filters

ANDROID — DEEP LINKS
  □ App Links preferred over custom URL Schemes
  □ Digital Asset Links configured correctly
  □ Deep link parameters validated and sanitised
  □ Auth checked before sensitive actions via deep link
  □ Redirection to external URLs impossible

iOS — URL SCHEMES
  □ Custom URL Schemes: parameters validated
  □ Universal Links preferred over URL Schemes
  □ AASA (apple-app-site-association) correctly configured
  □ Sensitive actions protected behind auth

WEBVIEW
  □ JavaScript disabled if not needed
  □ Loaded URLs explicitly whitelisted
  □ shouldOverrideUrlLoading / decidePolicyForNavigationAction implemented
  □ allowFileAccess = false
  □ allowUniversalAccessFromFileURLs = false
  □ JavaScript Bridge: minimum exposed methods
  □ WebView messages validated and sanitised
  □ No loading of user-provided URLs without validation

PERMISSIONS
  □ All declared permissions are used
  □ No unnecessary permissions declared
  □ Permissions requested at time of need
  □ App works if a permission is denied
  □ Sensitive permissions justified in privacy policy
    (Camera, Microphone, Location, Contacts, Storage)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 6 — CODE AND BUILD (MASVS-CODE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECRETS IN BINARY
  □ No API key in JS/Dart/Swift/Kotlin source code
  □ No internal endpoint (staging, dev) in production code
  □ No hardcoded password
  □ No encryption key in binary
  □ No unnecessary embedded certificate
  □ No internal URL revealing infrastructure

BUILD AND CONFIGURATION
  □ Debug mode disabled in release build
  □ Assertions disabled in release build
  □ ProGuard / R8 enabled in release (Android)
  □ Obfuscation configured for sensitive code
  □ Source maps not included in production build
  □ Secure signing configuration (keys protected)
  □ Reproducible build configured if possible

DEPENDENCIES
  □ Dependencies audited (npm audit / pub audit)
  □ No unaddressed critical CVE
  □ Lock files committed
  □ Native dependencies verified
  □ Third-party SDK: data policy verified
    (Analytics, Ads, Crash reporting: what do they collect?)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 7 — RESILIENCE (MASVS-RESILIENCE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  (Applicable to financial, health, national security apps)

  □ Root detection (Android) implemented
  □ Jailbreak detection (iOS) implemented
  □ Defined behavior if root/jailbreak detected
  □ Anti-tampering: binary integrity verification
  □ Anti-debug: debugger attachment detection
  □ Anti-emulator: emulator detection if needed
  □ Frida / hooking frameworks detection
  □ Advanced sensitive code obfuscation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 8 — COMPLIANCE AND PRIVACY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  □ Privacy policy present and accessible
  □ Explicit consent before data collection
  □ Data minimization
  □ Data deleted if account deleted
  □ Data portability right implemented
  □ Analytics: anonymization if possible
  □ Crash reporters: PII filtered before sending
  □ Accurate and complete App Store Privacy Label

═══════════════════════════════════════════════════════════════
MASVS SCORE:
  STORAGE    : [_]/8  CRYPTO    : [_]/6  AUTH     : [_]/7
  NETWORK    : [_]/7  PLATFORM  : [_]/9  CODE     : [_]/8
  RESILIENCE : [_]/8  (if applicable)
  
  TOTAL : [___] / [___] applicable items = ____%
═══════════════════════════════════════════════════════════════
