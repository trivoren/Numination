# 🔑 AUTH MOBILE — VULNERABILITY GUIDE
# Authentication and session management on mobile

═══════════════════════════════════════════════════════════════
              MOBILE AUTH VS WEB AUTH
═══════════════════════════════════════════════════════════════

WHAT IS DIFFERENT ON MOBILE
─────────────────────────────────
  WEB                        MOBILE
  ──────────────────────     ──────────────────────────────
  HttpOnly Cookies           Tokens in Keychain/Keystore
  Server sessions            Stateless JWT often used
  Browser cache cleared      Data persists on device
  No physical access         Device can be stolen
  Logout = cookie cleared    Logout = token actively deleted
  MFA via web                MFA via biometrics or TOTP app

MOBILE-SPECIFIC RISKS
───────────────────────────────
  1. Stolen token = permanent access if no expiration
  2. Stolen device = access if token in cleartext
  3. Biometrics bypassable if poorly implemented
  4. Session persists indefinitely on device
  5. Tokens copyable between devices if not device-bound

═══════════════════════════════════════════════════════════════
              MOBILE AUTH VULNERABILITIES
═══════════════════════════════════════════════════════════════

VULN-AUTH-001 — Token Stored Insecurely
  Severity: HIGH (CVSS 7.5)
  MASVS    : MASVS-AUTH-2
  
  The auth token = the keys to the kingdom.
  Its storage must be handled with the same rigor
  as a password.
  
  See VULN-STORAGE-001 for the complete fix.

VULN-AUTH-002 — Biometrics Implemented as Simple Boolean
  Severity: HIGH (CVSS 7.1)
  MASVS    : MASVS-AUTH-3
  
  Explanation:
    The vulnerable implementation:
    1. User places finger
    2. Biometric SDK returns true/false
    3. If true → display sensitive data
    
    With Frida, hook the method and always return true.
    Even without Frida, if the app checks a simple
    "biometric_ok=true" flag server-side, it's trivially bypassable.
  
  The correct implementation:
    Biometrics must unlock a CRYPTOGRAPHIC KEY
    that is needed to decrypt data or
    sign a server request.
    Without the key → no access, even if the check is bypassed.
  
  Fix:
    // react-native-keychain — Biometrics linked to key
    // See REM-MOB-007 in MOBILE-REMEDIATION-LIBRARY.md

VULN-AUTH-003 — No Inactivity Timeout
  Severity: MEDIUM (CVSS 5.5)
  MASVS    : MASVS-AUTH-2
  
  Explanation:
    If a user leaves their phone unlocked
    with the app open, anyone can access it.
    
    Banking, health, and finance apps MUST
    implement an inactivity timeout.
  
  Fix:
    // React Native — Inactivity timeout
    import { AppState } from 'react-native'
    
    const INACTIVITY_TIMEOUT = 5 * 60 * 1000 // 5 minutes
    
    export const useInactivityTimeout = (
      onTimeout: () => void
    ) => {
      const lastActivityRef = useRef(Date.now())
      const timerRef = useRef<ReturnType<typeof setTimeout>>()
      
      const resetTimer = useCallback(() => {
        lastActivityRef.current = Date.now()
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(onTimeout, INACTIVITY_TIMEOUT)
      }, [onTimeout])
      
      useEffect(() => {
        // Start timer
        resetTimer()
        
        // Listen for return to foreground
        const sub = AppState.addEventListener('change', state => {
          if (state === 'active') {
            const elapsed = Date.now() - lastActivityRef.current
            if (elapsed > INACTIVITY_TIMEOUT) {
              onTimeout()
            } else {
              resetTimer()
            }
          }
        })
        
        return () => {
          sub.remove()
          clearTimeout(timerRef.current)
        }
      }, [])
      
      return resetTimer // Call on every user interaction
    }

VULN-AUTH-004 — Non-Revocable Refresh Token
  Severity: HIGH (CVSS 7.2)
  MASVS    : MASVS-AUTH-2
  
  Explanation:
    If a refresh token is stolen and cannot be revoked:
    → Attacker has access as long as token is valid
    → Even after password change
    → Even after reporting the theft
  
  Server-side fix (backend):
    → Store refresh tokens in database
    → Allow revocation (logout = DB invalidation)
    → Implement rotation (each use generates a new token)
    → Detect reuse (if old token reused → compromise)
    
    // Rotation strategy:
    // 1. Client sends refresh_token
    // 2. Server checks validity in DB
    // 3. Server generates new access_token AND new refresh_token
    // 4. Server invalidates old refresh_token in DB
    // 5. If old token is reused → invalidate ENTIRE family
    //    (sign of compromise)

VULN-AUTH-005 — Client Certificate (mTLS) Absent for Critical Apps
  Severity: MEDIUM (CVSS 5.5)
  MASVS    : MASVS-AUTH-1
  
  Context: Banking, health, government apps
  
  Explanation:
    Certificate pinning verifies the server.
    mTLS (mutual TLS) ALSO allows the server
    to verify that the request comes from YOUR app
    on a LEGITIMATE DEVICE.
    
    Without mTLS, any script can call your API
    with a valid stolen token.
    With mTLS, the device must present a client certificate.
  
  Note: Complex implementation, reserved for critical apps.
  Evaluate the security/complexity trade-off per context.
