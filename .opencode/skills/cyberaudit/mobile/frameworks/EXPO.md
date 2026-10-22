# 🚀 EXPO — SECURITY AUDIT GUIDE
# Comprehensive audit guide for Expo / Expo Router applications

═══════════════════════════════════════════════════════════════
              EXPO — TWO MODES, TWO RISK MODELS
═══════════════════════════════════════════════════════════════

EXPO MANAGED WORKFLOW
──────────────────────
  → Expo handles native for you
  → Advantage: simplicity
  → Security risk: limited native modules
  
  IMPLICATIONS:
  → Keychain/Keystore via expo-secure-store only
  → Certificate pinning difficult in managed
  → No custom native modules
  → Expo Go = additional attack surface in dev

EXPO BARE WORKFLOW
──────────────────────
  → Full access to native code
  → Same security model as pure React Native
  → All React Native fixes apply

EXPO GO (DEVELOPMENT ONLY)
────────────────────────────────────
  ⚠️ EXPO GO MUST NEVER BE USED IN PRODUCTION
  → Expo Go can load any app via QR code
  → App secrets can be exposed
  → No certificate pinning possible in Expo Go

OTA UPDATES (EXPO UPDATES)
────────────────────────────
  → Expo allows Over-The-Air updates of the JS bundle
  → CRITICAL RISK: if the OTA channel is compromised,
    malicious code can be deployed to all devices
  → Verify: separate channels (dev/staging/prod)
  → Verify: update signing configured

═══════════════════════════════════════════════════════════════
              VULNERABLE EXPO PATTERNS
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPO SECURE STORE — CORRECT USAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 1 — AsyncStorage instead of SecureStore
  DETECT:
    import AsyncStorage from '@react-native-async-storage/async-storage'
    await AsyncStorage.setItem('token', authToken)
  
  FIX:
    import * as SecureStore from 'expo-secure-store'
    
    // expo-secure-store uses:
    // iOS → Keychain Services
    // Android → EncryptedSharedPreferences (API 23+)
    
    const TOKEN_KEY = 'auth_token'
    
    // Store
    await SecureStore.setItemAsync(TOKEN_KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      // WHEN_UNLOCKED_THIS_DEVICE_ONLY:
      // - Device must be unlocked to read
      // - Not in iCloud backups
      // - Bound to physical device
    })
    
    // Read
    const token = await SecureStore.getItemAsync(TOKEN_KEY)
    
    // Delete
    await SecureStore.deleteItemAsync(TOKEN_KEY)
    
    // ⚠️ LIMITATION: expo-secure-store has a size limit
    // Store only tokens, not large objects
    // For larger data:
    // Encrypt with a key stored in SecureStore
    // then store encrypted data in AsyncStorage

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPO ENVIRONMENT VARIABLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 2 — Secrets in app.config.js / app.json
  DETECT:
    // app.config.js
    export default {
      extra: {
        apiKey: 'sk-abc123...', // CRITICAL: in the bundle!
        dbPassword: 'secret',
        stripeKey: 'sk_live_...',
      }
    }
    
    // app.json
    {
      "expo": {
        "extra": {
          "apiKey": "sk-abc123..." // CRITICAL
        }
      }
    }
  
  UNDERSTAND:
    expo.extra is embedded in the app's JS bundle.
    Accessible via Constants.expoConfig.extra
    = visible in decompiled bundle
    = visible in Expo Go
  
  FIX:
    // app.config.js — Read from CI/CD environment
    export default {
      extra: {
        // ✅ Public key (not secret)
        apiUrl: process.env.EXPO_PUBLIC_API_URL,
        // EXPO_PUBLIC_ variables are injected into the bundle
        // Use ONLY for public values
        
        // ❌ Do NOT put here:
        // apiSecret, dbPassword, privateKey, etc.
      }
    }
    
    // Real secret keys stay server-side.
    // The mobile app should NOT have secrets.
    // It authenticates against a backend
    // which has access to the secrets.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPO UPDATES — OTA SECURITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 3 — Poorly configured OTA channels
  DETECT in app.config.js:
    updates: {
      url: 'https://u.expo.dev/...',
      // No channel configuration
      // No signature verification
    }
  
  FIX:
    // app.config.js
    updates: {
      url: 'https://u.expo.dev/YOUR-PROJECT-ID',
      enabled: true,
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
      codeSigningCertificate: './code-signing/certificate.pem',
      codeSigningMetadata: {
        keyid: 'main',
        alg: 'rsa-v1_5-sha256',
      },
    },
    runtimeVersion: {
      policy: 'appVersion',
    },
    
    // EAS Update: separate channels
    // eas.json
    // {
    //   "build": {
    //     "production": {
    //       "channel": "production"
    //     },
    //     "staging": {
    //       "channel": "staging"
    //     }
    //   }
    // }
    
    // Deploy to prod only after staging validation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPO DEEP LINKS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 4 — Expo Router without validation
  DETECT:
    // app/(tabs)/order/[id].tsx
    // ID comes directly from URL without validation
    
    export default function OrderScreen() {
      const { id } = useLocalSearchParams()
      // id used directly without validation
      const order = await fetchOrder(id) // IDOR possible!
    }
  
  FIX:
    // app/(tabs)/order/[id].tsx
    import { useLocalSearchParams, useRouter } from 'expo-router'
    
    export default function OrderScreen() {
      const { id } = useLocalSearchParams<{ id: string }>()
      const router = useRouter()
      
      // 1. Validate format
      const orderId = parseInt(id ?? '', 10)
      if (isNaN(orderId) || orderId <= 0) {
        router.replace('/not-found')
        return null
      }
      
      // 2. Ownership check is done server-side
      // The server verifies the order belongs
      // to the authenticated user
      const { data, error } = useQuery({
        queryKey: ['order', orderId],
        queryFn: () => orderApi.getById(orderId),
        // If 403 → server refused → error handled
      })
      
      // ...
    }

═══════════════════════════════════════════════════════════════
              COMPLETE EXPO CHECKLIST
═══════════════════════════════════════════════════════════════

STORAGE
  □ expo-secure-store for all tokens and secrets ?
  □ AsyncStorage only for non-sensitive data ?
  □ No secrets in expo.extra (app.config.js) ?

OTA UPDATES
  □ Code signing configured for OTA updates ?
  □ Separate channels: dev / staging / production ?
  □ runtime version policy configured ?
  □ Expo Go forbidden in production ?

DEEP LINKS / EXPO ROUTER
  □ URL parameters validated in each screen ?
  □ Auth checked before data access ?
  □ Universal Links configured (not URL scheme only) ?

ENVIRONMENT VARIABLES
  □ EXPO_PUBLIC_ only for non-secret values ?
  □ Secrets managed server-side only ?
  □ .env in .gitignore ?

BUILD EAS
  □ Secrets configured in EAS Secrets (not in code) ?
  □ Production build tested before release ?
  □ android.allowBackup=false in app.config.js ?
