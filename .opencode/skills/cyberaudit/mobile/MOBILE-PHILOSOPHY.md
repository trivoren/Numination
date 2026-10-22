# 📱 MOBILE AUDIT PHILOSOPHY — CYBERAUDIT SKILL
# The mindset of a mobile security expert

═══════════════════════════════════════════════════════════════
                    THE MOBILE MENTAL DNA
═══════════════════════════════════════════════════════════════

Mobile is not a small web in a box.
It is a radically different environment with:

  → A physical device that may be compromised
  → A systematically hostile network
  → A distributable binary analysable by anyone
  → A massive local attack surface (storage, IPC, sensors)
  → Users who will never read the permissions

When you audit a mobile app, you must think like
someone who physically has the device in their hands.

═══════════════════════════════════════════════════════════════
                    THE MOBILE MENTAL MODEL
═══════════════════════════════════════════════════════════════

IMAGINE THESE SCENARIOS:

SCENARIO 1 — THE STOLEN DEVICE
  The user's phone is stolen.
  The attacker has full physical access.
  → Stored data in cleartext is read
  → Unencrypted tokens are extracted
  → Unencrypted backups are exploited
  Question: What can the attacker see?

SCENARIO 2 — THE ROOTED/JAILBROKEN DEVICE
  The user themselves has rooted their device.
  They can read the complete filesystem.
  → AsyncStorage/SharedPreferences readable
  → Memory dumped
  → Frida hooks possible
  Question: Do your protections survive?

SCENARIO 3 — THE CAFÉ NETWORK
  The user is on public WiFi.
  An attacker performs MitM with mitmproxy.
  → Without certificate pinning: readable traffic
  → Intercepted tokens = stolen session
  → Personal data exposed
  Question: Is network communication secure?

SCENARIO 4 — THE DECOMPILED APK
  The attacker downloads the APK from the Play Store.
  They decompile it with jadx/apktool.
  → Hardcoded API keys found
  → Internal endpoints mapped
  → Client-side validation logic exposed
  Question: What does the binary reveal?

SCENARIO 5 — THE MALICIOUS DEEP LINK
  The user clicks a link in an SMS or email.
  This link opens the app via deep link.
  → Malicious parameters injected
  → Redirection to an unwanted action
  → Data exfiltration via the app
  Question: Are deep links validated?

═══════════════════════════════════════════════════════════════
                    THE 8 MOBILE COMMANDMENTS
═══════════════════════════════════════════════════════════════

COMMANDMENT 1 — THOU SHALT STORE NOTHING IN CLEARTEXT
  Keychain (iOS) and Keystore (Android) exist for this.
  AsyncStorage, SharedPreferences, NSUserDefaults = NEVER for sensitive data.
  Encrypt local databases (SQLCipher, encrypted Hive).

COMMANDMENT 2 — THOU SHALT PIN CERTIFICATES
  The network is hostile. Always.
  Certificate pinning = shield against MitM.
  Always have a backup pin.
  Have a rotation procedure before expiration.

COMMANDMENT 3 — THY BINARY SHALL BE EMPTY OF SECRETS
  Any secret in the binary is a public secret.
  Endpoints, API keys, tokens, credentials = outside the binary.
  Use secure configuration backends.

COMMANDMENT 4 — THOU SHALT ASK THE MINIMUM OF PERMISSIONS
  Every permission is an attack surface.
  Every unnecessary permission = unnecessary risk.
  Ask at time of need, not at startup.

COMMANDMENT 5 — THOU SHALT VALIDATE ALL DEEP LINKS
  An unvalidated deep link = a mobile injection.
  Check the scheme, path, and parameters.
  Check authentication state before action.

COMMANDMENT 6 — THOU SHALT EXPOSE NOTHING IN LOGS
  console.log() in production = data leak.
  Logs are readable on a rooted device.
  Totally disable sensitive logs in prod.

COMMANDMENT 7 — THOU SHALT ENCRYPT THE LOCAL DATABASE
  An unencrypted SQLite DB = directly readable file.
  SQLCipher for React Native.
  encrypted for Flutter Hive.
  Core Data with encryption for native iOS.

COMMANDMENT 8 — THOU SHALT RESIST REVERSE ENGINEERING
  Code obfuscation (ProGuard, r8 for Android).
  Anti-debug (detect Frida, LLDB attached).
  Integrity checks (detect binary modification).
  Root/Jailbreak detection as an additional layer.

═══════════════════════════════════════════════════════════════
                    THE MOBILE AUDIT FLOW
═══════════════════════════════════════════════════════════════

PHASE 0 — MOBILE RECONNAISSANCE
════════════════════════════════
  
  □ Framework: React Native / Flutter / Ionic / Expo ?
  □ Target SDK versions (iOS min, Android min) ?
  □ Permissions declared in AndroidManifest.xml ?
  □ Permissions declared in Info.plist ?
  □ Exported Android components ?
    (Activities, Services, Receivers, Providers)
  □ Declared URL Schemes (iOS) ?
  □ App Links / Deep Links configured (Android) ?
  □ Network Security Config present (Android) ?
  □ App Transport Security config (iOS) ?
  □ Native libraries used ?

PHASE 1 — LOCAL STORAGE AUDIT
════════════════════════════════
  
  MAXIMUM PRIORITY — Data at rest
  
  □ AsyncStorage / SharedPreferences used ?
    → Search for: tokens, passwords, PII
    → Search for: financial data, health data
    → If yes: HIGH minimum
  
  □ Keychain (iOS) / Keystore (Android) used for secrets ?
    → Verify configured access controls
    → Verify accessibility options
  
  □ SQLite / Local database ?
    → Encrypted with SQLCipher ?
    → Where is the encryption key stored ?
  
  □ Sensitive local files ?
    → PDFs, images, documents with PII data
    → Stored in public or private directory ?
    → Included in backups ?
  
  □ HTTP cache ?
    → Sensitive data cached ?
    → NSURLCache / OkHttp unsecured cache ?
  
  □ Keyboard cache ?
    → Sensitive fields (password, CC) with autocorrect disabled ?
    → textContentType configured correctly ?
  
  □ Background screenshots ?
    → App hidden when moved to background ?
    → FLAG_SECURE (Android) / ignoresSiblingOrder (iOS) ?

PHASE 2 — MOBILE NETWORK AUDIT
═══════════════════════════════
  
  □ HTTPS used exclusively ?
    → Search for http:// in hardcoded URLs
    → Network Security Config: cleartext disabled ?
    → App Transport Security: no exceptions ?
  
  □ Certificate Pinning implemented ?
    → On critical endpoints (auth, payment, personal data)
    → Backup pin present ?
    → Pin expiration date configured ?
    → Update procedure documented ?
  
  □ Auth tokens in headers (Authorization: Bearer) ?
    → Not in query parameters (exposed in logs)
    → Not in GET body (non-standard)
  
  □ Timeout configured ?
    → Network requests without timeout = DoS by resources
  
  □ Retry logic with exponential backoff ?
    → Avoid accidental DDoS on your own servers

PHASE 3 — BINARY AUDIT
═════════════════════════
  
  □ Hardcoded secrets ?
    → API keys, tokens, passwords
    → Internal environment URLs (staging, dev)
    → Encryption keys
    → Embedded certificates
  
  □ Obfuscated code ?
    → Android: ProGuard/R8 enabled in release ?
    → React Native: Hermes + JS obfuscation ?
    → Flutter: native compiled code (good) but Dart strings ?
  
  □ Debug mode detectable ?
    → BuildConfig.DEBUG (Android)
    → #if DEBUG (iOS)
    → __DEV__ (React Native)
    → Disabled in release build ?
  
  □ Stack traces in production ?
    → Crash reporters configured not to send local data ?
    → Sentry/Firebase Crashlytics: sensitive data filtered ?
  
  □ Development logs in production ?
    → console.log(), print(), NSLog() in release ?
    → Log level filtering configured ?

PHASE 4 — IPC AND DEEP LINK AUDIT
═══════════════════════════════════
  
  ANDROID:
  □ Activities exported without protection ?
    → android:exported="true" without required permission ?
    → Intent filters exposing sensitive functionality ?
  
  □ Broadcast Receivers exported ?
    → Receiving unauthenticated broadcasts ?
    → Sensitive data in broadcasts ?
  
  □ Content Providers exported ?
    → Data access without permission check ?
    → SQL injection in Content Providers ?
  
  □ Deep Links / App Links validated ?
    → Parameters sanitised ?
    → Auth checked before action ?
    → Redirection to external URLs possible ?
  
  iOS:
  □ URL Schemes validated ?
    → Parameters sanitised ?
    → Sensitive actions protected ?
  
  □ Universal Links configured ?
    → AASA (apple-app-site-association) correctly configured ?
    → Preferred over URL Schemes for security ?
  
  ALL FRAMEWORKS:
  □ WebView used ?
    → JavaScript Bridge exposed ?
    → Allowed URLs whitelisted ?
    → JavaScript from untrusted sources executed ?
    → shouldOverrideUrlLoading implemented ?

PHASE 5 — MOBILE AUTHENTICATION AUDIT
═════════════════════════════════════════
  
  □ Tokens stored securely ?
    → Keychain/Keystore, not AsyncStorage/SharedPreferences
  
  □ Token expiration managed ?
    → Short access token (15min)
    → Refresh token with rotation
    → Server-side invalidation possible ?
  
  □ Biometrics implemented correctly ?
    → Not just a UI check (bypassable)
    → Cryptographic key linked to biometrics
    → invalidatedByBiometricEnrollment = true
  
  □ Jailbreak/root behavior ?
    → App refusing to work? (too strict)
    → App warning the user? (reasonable)
    → Sensitive data deleted? (recommended)
  
  □ Inactive session timeout ?
    → After X minutes of inactivity → re-auth required
  
  □ Client certificate (mTLS) for highly sensitive apps ?

PHASE 6 — PERMISSIONS AUDIT
═════════════════════════════
  
  FOR EACH DECLARED PERMISSION:
  □ Is the permission actually used ?
  □ Is the permission necessary for the feature ?
  □ Is there a less invasive alternative ?
  □ Requested at time of need (not at startup) ?
  □ Can the user refuse without the app crashing ?
  
  SENSITIVE PERMISSIONS TO INSPECT:
  □ Camera → Justified? Used only when necessary ?
  □ Microphone → Justified? Visible usage indicator ?
  □ Location → Fine or Coarse? Background justified ?
  □ Contacts → Really necessary? Upload to server ?
  □ Storage → Full access or dedicated folder ?
  □ Phone/SMS → Justified? (often unnecessary)
  □ Biometrics → Secure implementation ?

═══════════════════════════════════════════════════════════════
              OWASP MASVS 2.0 — COMPLETE MAPPING
═══════════════════════════════════════════════════════════════

MASVS-STORAGE
  MASVS-STORAGE-1 : No sensitive data in insecure storage
  MASVS-STORAGE-2 : No sensitive data in logs
  MASVS-STORAGE-3 : No sensitive data in unencrypted backups
  MASVS-STORAGE-4 : No sensitive data in UI cache
  MASVS-STORAGE-5 : Keyboard cache disabled on sensitive fields
  MASVS-STORAGE-6 : Clipboard not exposed on sensitive data
  MASVS-STORAGE-7 : Sensitive data removed when no longer needed
  MASVS-STORAGE-8 : Local DB encrypted if sensitive data

MASVS-CRYPTO
  MASVS-CRYPTO-1 : Modern cryptographic algorithms only
  MASVS-CRYPTO-2 : Standard implementations (no custom)
  MASVS-CRYPTO-3 : Secure random generation
  MASVS-CRYPTO-4 : Secure cryptographic key management
  MASVS-CRYPTO-5 : No hardcoded secrets

MASVS-AUTH
  MASVS-AUTH-1 : Server-side auth, not client
  MASVS-AUTH-2 : Secure session management
  MASVS-AUTH-3 : Biometrics correctly implemented
  MASVS-AUTH-4 : Strong password policy

MASVS-NETWORK
  MASVS-NETWORK-1 : HTTPS exclusively
  MASVS-NETWORK-2 : Strict certificate verification
  MASVS-NETWORK-3 : Up-to-date network libraries

MASVS-PLATFORM
  MASVS-PLATFORM-1 : Correct use of platform APIs
  MASVS-PLATFORM-2 : Validated and secured deep links
  MASVS-PLATFORM-3 : Secure IPC
  MASVS-PLATFORM-4 : Secured WebViews
  MASVS-PLATFORM-5 : Components not unnecessarily exported (Android)
  MASVS-PLATFORM-6 : JavaScript disabled in WebViews if unnecessary
  MASVS-PLATFORM-7 : Minimal permissions

MASVS-CODE
  MASVS-CODE-1 : Security tests in CI/CD pipeline
  MASVS-CODE-2 : All third-party components up to date
  MASVS-CODE-3 : App detects binary manipulation
  MASVS-CODE-4 : App implements obfuscation if necessary

MASVS-RESILIENCE
  MASVS-RESILIENCE-1 : Root/Jailbreak detection
  MASVS-RESILIENCE-2 : Anti-tampering
  MASVS-RESILIENCE-3 : Anti-debugging
  MASVS-RESILIENCE-4 : Anti-reverse-engineering
