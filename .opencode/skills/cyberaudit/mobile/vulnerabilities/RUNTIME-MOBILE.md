# ⚡ RUNTIME MOBILE — VULNERABILITY GUIDE
# Runtime security for mobile applications

═══════════════════════════════════════════════════════════════
              RUNTIME SECURITY — CONCEPT
═══════════════════════════════════════════════════════════════

RUNTIME SECURITY PROTECTS THE APP DURING EXECUTION
────────────────────────────────────────────────────────
  Unlike static security (code, config),
  runtime security protects against:
  → App behavior modifications (Frida, hooking)
  → Execution in a compromised environment (root, jailbreak)
  → Unauthorised debugging
  → Binary modification (repackaging)
  → Emulation (for apps requiring a real device)

RUNTIME PROTECTION LEVELS
───────────────────────────────
  LEVEL 1 — Detection and information
    → Detect root/jailbreak
    → Inform the user of the risk
    → Limit sensitive features
    (Appropriate for most apps)
  
  LEVEL 2 — Detection and restriction
    → Detect root/jailbreak + Frida
    → Refuse to run in degraded mode
    → Delete sensitive data from device
    (Banking, health apps)
  
  LEVEL 3 — Active protection
    → All of level 2
    → Advanced anti-debug
    → Detection code obfuscation
    → Binary integrity verification
    (Government, defence apps)

═══════════════════════════════════════════════════════════════
              RUNTIME VULNERABILITIES
═══════════════════════════════════════════════════════════════

VULN-RUNTIME-001 — No Root/Jailbreak Detection
  Severity: MEDIUM to HIGH depending on context
  MASVS    : MASVS-RESILIENCE-1
  
  Impact by app type:
  Banking app   : HIGH (financial data at risk)
  Health app    : HIGH (medical data at risk)
  General public app: MEDIUM (reduce attack surface)
  Gaming app    : LOW (anti-cheat primarily)
  
  React Native fix:
    // npm install react-native-device-info
    import DeviceInfo from 'react-native-device-info'
    
    // npm install jail-monkey
    import JailMonkey from 'jail-monkey'
    
    export const checkDeviceSecurity = async () => {
      const isJailBroken = JailMonkey.isJailBroken()
      const isOnExternalStorage = JailMonkey.isOnExternalStorage()
      const canMockLocation = JailMonkey.canMockLocation()
      const hasHooks = JailMonkey.hookDetected()
      
      const isCompromised =
        isJailBroken ||
        isOnExternalStorage ||
        hasHooks
      
      return {
        isCompromised,
        reasons: {
          isJailBroken,
          isOnExternalStorage,
          canMockLocation,
          hasHooks,
        }
      }
    }
    
    // Usage at app startup
    const { isCompromised, reasons } = await checkDeviceSecurity()
    
    if (isCompromised) {
      // For non-critical apps: warning
      Alert.alert(
        'Security',
        'Your device appears to be modified. '
        + 'Your data security may be reduced.',
        [{ text: 'Continue', style: 'destructive' }]
      )
      
      // For critical apps: block
      Alert.alert(
        'Access denied',
        'The application cannot run '
        + 'on a rooted/jailbroken device.',
        [{
          text: 'Exit',
          onPress: () => RNExitApp.exitApp(),
        }]
      )
    }

VULN-RUNTIME-002 — No Frida Detection
  Severity: HIGH for critical apps
  MASVS    : MASVS-RESILIENCE-3
  
  What is Frida?
    Frida is a dynamic instrumentation framework.
    It can hook app functions at runtime
    and modify their behavior.
    
    Examples of attacks via Frida:
    → Bypass biometric verification
    → Key extraction from Keychain
    → Bypass root detection
    → Modify transaction amounts
  
  Fix:
    // Basic detection via Frida port (27042)
    // and characteristic process names
    
    // For serious protection:
    // → Use a commercial protection library
    //   (Guardsquare DexGuard, Arxan, Appdome)
    // → Or implement native checks (NDK)
    //   as JavaScript checks are more easily bypassed
    
    // Basic detection (can be bypassed):
    import JailMonkey from 'jail-monkey'
    
    const hasFridaDetected = JailMonkey.hookDetected()
    
    // ⚠️ This detection alone is insufficient
    // for highly critical apps
    // An advanced attacker can bypass JailMonkey

VULN-RUNTIME-003 — Sensitive Data in Memory
  Severity: MEDIUM
  MASVS    : MASVS-STORAGE-1
  
  Explanation:
    On a rooted device, app memory can be dumped.
    Sensitive data held in memory too long is at risk.
    
    Particularly critical for:
    → Encryption keys
    → Entered passwords
    → Biometric data (templates)
    → Auth tokens
  
  Best practices:
    → Clear sensitive data after use
    → Use data types that support clearing
    → Do not cache sensitive data
    → Cryptographic keys: let Keystore handle them
      (it never exposes them in application memory)
    
    // React Native — Clear sensitive data
    // Note: JavaScript does not guarantee memory clearing
    // For real protection → native code (NDK/NDK)
    
    let sensitiveData = await getPassword()
    try {
      // Use the data
      await doSensitiveOperation(sensitiveData)
    } finally {
      // "Clear" — limited in JS but better than nothing
      sensitiveData = null
    }

VULN-RUNTIME-004 — Detectable Debug Mode
  Severity: MEDIUM
  MASVS    : MASVS-CODE-2
  
  Detection:
    An attacker can detect if an app is in debug
    to adapt their attack.
    
    BuildConfig.DEBUG = true (Android)
    → Attacker knows the app is in debug mode
    → Debug features may be active
    → Logs are probably verbose
  
  Fix:
    // React Native — Ensure __DEV__ = false in prod
    // Test with release build
    
    console.log('DEV mode:', __DEV__)
    // Must be false in release
    
    // Android — Verify in build.gradle
    // release { debuggable false }
    
    // Runtime check
    if (__DEV__) {
      console.warn('Application in development mode')
    }

═══════════════════════════════════════════════════════════════
              COMPLETE RUNTIME CHECKLIST
═══════════════════════════════════════════════════════════════

  □ Root/Jailbreak detection implemented ?
  □ Defined behavior if compromise detected ?
  □ Frida detection (if critical app) ?
  □ Anti-debug implemented (if very critical app) ?
  □ Sensitive data cleared from memory after use ?
  □ Debug mode disabled in production build ?
  □ Binary integrity verification (if critical app) ?
  □ Emulator behavior defined ?
  □ Production build tested with active protections ?
