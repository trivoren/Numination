# 🔬 BINARY ANALYSIS — MOBILE VULNERABILITY GUIDE
# Binary security and reverse engineering protection

═══════════════════════════════════════════════════════════════
              WHAT IS BINARY ANALYSIS?
═══════════════════════════════════════════════════════════════

YOUR APK/IPA IS PUBLIC
─────────────────────────
  Any user can:
  → Download the APK from the Play Store
  → Extract the IPA from a jailbroken device
  → Download from third-party stores
  
  With the APK/IPA, an attacker can:
  → Extract all strings from the binary
  → Reconstruct code logic
  → Find hidden API endpoints
  → Find hardcoded secrets
  → Modify the code and repackage the app
  → Bypass client-side security controls

COMMON BINARY ANALYSIS TOOLS
────────────────────────────────────
  apktool         → Decompiles APK (resources + smali)
  jadx            → Decompiles to readable Java/Kotlin
  ghidra          → Analyses native code (NDK)
  frida           → Runtime hooking (modify behavior)
  objection       → Mobile pentest framework based on Frida
  radare2         → Advanced static analysis
  strings         → Extract strings from binary
  class-dump      → Extract iOS interfaces
  Hopper          → iOS/macOS disassembler

REACT NATIVE — THE SPECIAL CASE
────────────────────────────────────
  React Native JavaScript code is in:
  Android: assets/index.android.bundle
  iOS    : main.jsbundle
  
  It is directly readable:
  strings index.android.bundle | grep -i "api\|key\|secret"
  
  Even "minified", the code remains readable JavaScript
  and can be reformatted with tools.

═══════════════════════════════════════════════════════════════
              BINARY VULNERABILITIES
═══════════════════════════════════════════════════════════════

VULN-BIN-001 — Hardcoded Secrets in Binary
  Severity: CRITICAL (CVSS 9.1)
  MASVS    : MASVS-CRYPTO-5
  
  What is found in binaries in practice:
  → Third-party API keys (Stripe, Twilio, AWS)
  → Internal environment URLs (staging, admin)
  → Encryption keys
  → Test tokens left in production
  → Undocumented API endpoints
  → Database credentials (rare but documented error)
  
  Detection commands:
    # Extract strings from a React Native APK
    unzip app.apk
    strings assets/index.android.bundle | \
      grep -iE "(api_key|secret|password|token|bearer|sk-|pk_live)"
    
    # With jadx (Kotlin/Java code)
    jadx app.apk -d output/
    grep -r "apiKey\|secret\|password" output/sources/
    
    # iOS
    strings App.app/App | grep -iE "(key|secret|token)"
  
  Fix:
    → No secrets in source code (frontend or mobile)
    → Use environment variables injected at build time
    → Real secret keys remain server-side
    → The mobile app authenticates and receives
      temporary tokens from the server which has the real secrets

VULN-BIN-002 — No Obfuscation (Android)
  Severity: MEDIUM (CVSS 4.0)
  MASVS    : MASVS-CODE-4
  
  Explanation:
    Without obfuscation, code decompiled with jadx
    is nearly identical to the original source code.
    → Business logic exposed
    → Proprietary algorithms copiable
    → Logical vulnerabilities easier to find
  
  Fix for Android (build.gradle):
    android {
      buildTypes {
        release {
          minifyEnabled true
          shrinkResources true
          proguardFiles getDefaultProguardFile(
            'proguard-android-optimize.txt'
          ), 'proguard-rules.pro'
        }
      }
    }
    
    // proguard-rules.pro — Protect sensitive logic
    -keep class com.yourapp.models.** { *; }
    -keepclassmembers class * {
      @com.google.gson.annotations.SerializedName <fields>;
    }
    // Obfuscate the rest

VULN-BIN-003 — Debug Code in Production
  Severity: HIGH (CVSS 7.5)
  MASVS    : MASVS-CODE-2
  
  Detection:
    BuildConfig.DEBUG = true in release
    android:debuggable="true" in manifest
    /debug, /test, /dev endpoints accessible
    Verbose logs enabled in prod
    Expo developer mode active
  
  Fix:
    // Android — automatically false in release build
    // Verify in build.gradle:
    buildTypes {
      release {
        debuggable false // Explicit
        minifyEnabled true
      }
    }
    
    // React Native — use __DEV__
    if (__DEV__) {
      // Debug code only
    }
    
    // Verify app is in release mode:
    // npx react-native run-android --mode=release
    // npx react-native run-ios --configuration Release

VULN-BIN-004 — Source Maps in Production
  Severity: HIGH (CVSS 6.5)
  MASVS    : MASVS-CODE-4
  
  Explanation:
    Source maps allow reconstructing the exact
    source code from the minified bundle.
    If included in production build:
    → 100% readable source code
    → Original variable/function names
    → Project structure exposed
  
  Fix:
    // React Native — metro.config.js
    module.exports = {
      transformer: {
        // In production: no source maps
        enableBabelRCLookup: false,
      },
    }
    
    // EAS Build — eas.json
    // Source maps can be uploaded to Sentry
    // WITHOUT being included in the app
    {
      "build": {
        "production": {
          "env": {
            "SENTRY_ORG": "...",
            "SENTRY_PROJECT": "..."
          }
        }
      }
    }
    
    // sentry.properties — Separate upload
    // Source maps go to Sentry, not in the APK

═══════════════════════════════════════════════════════════════
              BINARY ANALYSIS CHECKLIST
═══════════════════════════════════════════════════════════════

  □ No secrets in index.android.bundle / main.jsbundle ?
  □ No secrets in compiled Kotlin/Swift files ?
  □ No internal URLs in the binary ?
  □ ProGuard/R8 enabled for Android release ?
  □ android:debuggable="false" in release manifest ?
  □ Source maps not included in production build ?
  □ Binary strings analysed before each release ?
  □ Release build tested different from dev build ?
