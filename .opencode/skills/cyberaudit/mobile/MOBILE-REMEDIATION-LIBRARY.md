# 🔧 MOBILE REMEDIATION LIBRARY — CYBERAUDIT SKILL
# Complete fix library for mobile vulnerabilities

═══════════════════════════════════════════════════════════════
              REM-MOB-001 — SECURED ASYNCSTORAGE
═══════════════════════════════════════════════════════════════

ISSUE: Sensitive data in AsyncStorage (unencrypted)
SEVERITY: HIGH
MASVS    : MASVS-STORAGE-1

BEFORE (Vulnerable):
  await AsyncStorage.setItem('auth_token', token)
  await AsyncStorage.setItem('user_password', password)
  await AsyncStorage.setItem('card_number', cardNumber)

AFTER (Secured):
  // yarn add react-native-keychain
  import * as Keychain from 'react-native-keychain'
  
  // Store
  await Keychain.setGenericPassword(
    'auth',
    token,
    {
      service: 'com.yourapp.auth-token',
      accessControl: Keychain.ACCESS_CONTROL
                              .BIOMETRY_ANY_OR_DEVICE_PASSCODE,
      accessible: Keychain.ACCESSIBLE
                           .WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }
  )
  
  // Retrieve
  const creds = await Keychain.getGenericPassword({
    service: 'com.yourapp.auth-token'
  })
  const token = creds ? creds.password : null
  
  // Delete (logout)
  await Keychain.resetGenericPassword({
    service: 'com.yourapp.auth-token'
  })
  
  // For less critical data (user preferences)
  // EncryptedStorage is acceptable
  import EncryptedStorage from 'react-native-encrypted-storage'
  
  await EncryptedStorage.setItem(
    'user_preferences',
    JSON.stringify({ theme: 'dark', language: 'fr' })
  )

═══════════════════════════════════════════════════════════════
              REM-MOB-002 — CERTIFICATE PINNING RN
═══════════════════════════════════════════════════════════════

ISSUE: No certificate pinning
SEVERITY: HIGH
MASVS    : MASVS-NETWORK-2

AFTER (Secured):
  // yarn add react-native-ssl-pinning
  import { fetch as pinnedFetch } from 'react-native-ssl-pinning'
  
  // Obtain pins:
  // openssl s_client -connect api.yourapp.com:443 < /dev/null 2>/dev/null \
  //   | openssl x509 -pubkey -noout \
  //   | openssl pkey -pubin -outform der \
  //   | openssl dgst -sha256 -binary \
  //   | base64
  
  const PINS = {
    primary: 'ABC123...base64==',
    backup:  'XYZ789...base64==', // MANDATORY
  }
  
  // Secure API service
  class SecureApiService {
    private baseUrl = 'https://api.yourapp.com'
    
    async get<T>(endpoint: string): Promise<T> {
      const response = await pinnedFetch(
        `${this.baseUrl}${endpoint}`,
        {
          method: 'GET',
          sslPinning: {
            certs: [PINS.primary, PINS.backup],
          },
          headers: {
            Authorization: `Bearer ${await this.getToken()}`,
            'Content-Type': 'application/json',
          },
        }
      )
      return response.json()
    }
    
    async post<T>(endpoint: string, body: object): Promise<T> {
      const response = await pinnedFetch(
        `${this.baseUrl}${endpoint}`,
        {
          method: 'POST',
          sslPinning: {
            certs: [PINS.primary, PINS.backup],
          },
          body: JSON.stringify(body),
          headers: {
            Authorization: `Bearer ${await this.getToken()}`,
            'Content-Type': 'application/json',
          },
        }
      )
      return response.json()
    }
    
    private async getToken(): Promise<string> {
      const creds = await Keychain.getGenericPassword({
        service: 'com.yourapp.auth-token'
      })
      return creds ? creds.password : ''
    }
  }

═══════════════════════════════════════════════════════════════
              REM-MOB-003 — SCREENSHOT PROTECTION
═══════════════════════════════════════════════════════════════

ISSUE: Sensitive data visible in app switcher
SEVERITY: MEDIUM
MASVS    : MASVS-STORAGE-4

AFTER (Secured):
  // React Native hook
  import { AppState, Platform, View, Image } from 'react-native'
  import { useEffect, useState } from 'react'
  
  export const useScreenProtection = () => {
    const [isHidden, setIsHidden] = useState(false)
    
    useEffect(() => {
      const sub = AppState.addEventListener('change', state => {
        setIsHidden(
          state === 'background' || state === 'inactive'
        )
      })
      return () => sub.remove()
    }, [])
    
    return isHidden
  }
  
  // Wrapper component
  export const ProtectedView = ({ children, style }) => {
    const isHidden = useScreenProtection()
    
    return (
      <View style={[style, { flex: 1 }]}>
        {isHidden ? (
          <View style={styles.overlay}>
            <Image
              source={require('@/assets/splash.png')}
              style={styles.logo}
            />
          </View>
        ) : (
          children
        )}
      </View>
    )
  }
  
  // Android: FLAG_SECURE in MainActivity.java
  // import android.view.WindowManager;
  // getWindow().setFlags(
  //   WindowManager.LayoutParams.FLAG_SECURE,
  //   WindowManager.LayoutParams.FLAG_SECURE
  // );

═══════════════════════════════════════════════════════════════
              REM-MOB-004 — SECURE LOGGER
═══════════════════════════════════════════════════════════════

ISSUE: console.log with sensitive data in production
SEVERITY: MEDIUM
MASVS    : MASVS-STORAGE-2

AFTER (Secured):
  // utils/logger.ts
  
  type LogLevel = 'debug' | 'info' | 'warn' | 'error'
  
  const isProduction = !__DEV__
  
  const sanitize = (data: unknown): unknown => {
    if (typeof data !== 'object' || data === null) return data
    
    const sensitiveKeys = [
      'token', 'password', 'secret', 'apiKey',
      'authorization', 'credit_card', 'ssn', 'pin'
    ]
    
    const sanitized = { ...data as Record<string, unknown> }
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
        sanitized[key] = '[REDACTED]'
      }
    }
    return sanitized
  }
  
  export const logger = {
    debug: (...args: unknown[]) => {
      if (!isProduction) console.log('[DEBUG]', ...args)
    },
    
    info: (...args: unknown[]) => {
      if (!isProduction) console.info('[INFO]', ...args)
    },
    
    warn: (...args: unknown[]) => {
      if (!isProduction) console.warn('[WARN]', ...args)
    },
    
    // In prod: send to monitoring service
    // without sensitive data
    error: (message: string, error?: Error, context?: object) => {
      if (!isProduction) {
        console.error('[ERROR]', message, error, context)
      }
      
      // Crashlytics / Sentry without sensitive data
      const safeContext = context ? sanitize(context) : undefined
      crashReporter.recordError(error ?? new Error(message), {
        message,
        context: safeContext,
      })
    },
    
    // Never call with sensitive data
    sensitive: () => { /* intentionally no-op */ },
  }

═══════════════════════════════════════════════════════════════
              REM-MOB-005 — DEEP LINK VALIDATION
═══════════════════════════════════════════════════════════════

ISSUE: Deep links without parameter validation
SEVERITY: HIGH
MASVS    : MASVS-PLATFORM-2

AFTER (Secured):
  // navigation/DeepLinkHandler.ts
  import { Linking } from 'react-native'
  import { getAuthToken } from '@/services/auth'
  
  type DeepLinkRoute = {
    screen: string
    params?: Record<string, unknown>
    requiresAuth: boolean
  }
  
  const ALLOWED_ROUTES: Record<string, DeepLinkRoute> = {
    '/product': {
      screen: 'ProductDetail',
      requiresAuth: false,
    },
    '/order': {
      screen: 'OrderDetail',
      requiresAuth: true,
    },
    '/payment': {
      screen: 'Payment',
      requiresAuth: true,
    },
  }
  
  export const handleDeepLink = async (
    url: string,
    navigation: NavigationProp<any>
  ): Promise<void> => {
    // 1. Parse URL
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      console.warn('Invalid deep link URL')
      return
    }
    
    // 2. Verify scheme
    const allowedSchemes = ['yourapp:', 'https:']
    if (!allowedSchemes.includes(parsed.protocol)) return
    
    // 3. If HTTPS, verify host
    if (parsed.protocol === 'https:') {
      const allowedHosts = ['app.yourapp.com', 'yourapp.com']
      if (!allowedHosts.includes(parsed.hostname)) return
    }
    
    // 4. Verify route is allowed
    const routeConfig = ALLOWED_ROUTES[parsed.pathname]
    if (!routeConfig) return
    
    // 5. Verify auth if needed
    if (routeConfig.requiresAuth) {
      const token = await getAuthToken()
      if (!token) {
        navigation.navigate('Login', {
          returnTo: url,
        })
        return
      }
    }
    
    // 6. Validate and sanitize parameters
    const params: Record<string, unknown> = {}
    
    // Example: numeric ID only
    if (parsed.searchParams.has('id')) {
      const id = parseInt(
        parsed.searchParams.get('id') ?? '', 10
      )
      if (isNaN(id) || id <= 0) return
      params.id = id
    }
    
    // 7. Navigate securely
    navigation.navigate(routeConfig.screen, params)
  }

═══════════════════════════════════════════════════════════════
              REM-MOB-006 — SECURED ANDROID MANIFEST
═══════════════════════════════════════════════════════════════

ISSUE: AndroidManifest.xml with poor configuration
SEVERITY: HIGH
MASVS    : MASVS-PLATFORM-1, MASVS-STORAGE-3

AFTER (Secured):
  <!-- Complete secured AndroidManifest.xml -->
  <manifest xmlns:android="http://schemas.android.com/apk/res/android">
  
    <!-- Minimum permissions -->
    <uses-permission android:name="android.permission.INTERNET" />
    <!-- Add only what is actually used -->
  
    <application
      android:allowBackup="false"
      android:fullBackupContent="@xml/backup_rules"
      android:dataExtractionRules="@xml/data_extraction_rules"
      android:usesCleartextTraffic="false"
      android:networkSecurityConfig="@xml/network_security_config"
      android:debuggable="false"
      android:extractNativeLibs="false">
      
      <activity
        android:name=".MainActivity"
        android:exported="true"
        android:launchMode="singleTask">
        
        <!-- Deep Links via App Links (HTTPS only) -->
        <intent-filter android:autoVerify="true">
          <action android:name="android.intent.action.VIEW" />
          <category android:name="android.intent.category.DEFAULT" />
          <category android:name="android.intent.category.BROWSABLE" />
          <data
            android:scheme="https"
            android:host="app.yourapp.com" />
        </intent-filter>
      </activity>
      
      <!-- Internal services: not exported -->
      <service
        android:name=".InternalService"
        android:exported="false" />
      
      <!-- Internal providers: not exported -->
      <provider
        android:name=".InternalProvider"
        android:exported="false"
        android:authorities="com.yourapp.internal" />
        
    </application>
  </manifest>
  
  <!-- res/xml/network_security_config.xml -->
  <?xml version="1.0" encoding="utf-8"?>
  <network-security-config>
    <base-config cleartextTrafficPermitted="false">
      <trust-anchors>
        <certificates src="system" />
      </trust-anchors>
    </base-config>
    
    <domain-config>
      <domain includeSubdomains="true">api.yourapp.com</domain>
      <pin-set expiration="2026-12-31">
        <pin digest="SHA-256">PRIMARY_PIN_BASE64==</pin>
        <pin digest="SHA-256">BACKUP_PIN_BASE64==</pin>
      </pin-set>
    </domain-config>
  </network-security-config>
  
  <!-- res/xml/backup_rules.xml -->
  <?xml version="1.0" encoding="utf-8"?>
  <full-backup-content>
    <!-- Exclude all sensitive data from backups -->
    <exclude domain="sharedpref" path="." />
    <exclude domain="database" path="." />
    <exclude domain="file" path="." />
  </full-backup-content>

═══════════════════════════════════════════════════════════════
              REM-MOB-007 — SECURE BIOMETRICS
═══════════════════════════════════════════════════════════════

ISSUE: Biometrics implemented as a simple UI check
SEVERITY: HIGH
MASVS    : MASVS-AUTH-3

AFTER (Secured):
  // Biometrics must be linked to a cryptographic key
  // Not just: if (biometricResult === true) → access
  
  // React Native with react-native-keychain
  import * as Keychain from 'react-native-keychain'
  
  // Store with biometric protection
  const storeSensitiveData = async (data: string) => {
    await Keychain.setGenericPassword(
      'protected-data',
      data,
      {
        service: 'com.yourapp.biometric-protected',
        accessControl: 
          Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
        // BIOMETRY_CURRENT_SET = invalidated if new fingerprints
        // added → enhanced security
        accessible:
          Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        authenticationType:
          Keychain.AUTHENTICATION_TYPE.BIOMETRICS,
      }
    )
  }
  
  // Retrieve with biometric validation
  const getProtectedData = async (): Promise<string | null> => {
    try {
      const creds = await Keychain.getGenericPassword({
        service: 'com.yourapp.biometric-protected',
        authenticationPrompt: {
          title: 'Authentication required',
          subtitle: 'Confirm your identity to access',
          cancel: 'Cancel',
        },
      })
      
      // Biometrics was verified by Keychain
      // (not just a JS boolean)
      return creds ? creds.password : null
      
    } catch (error) {
      // Biometrics denied or unavailable
      return null
    }
  }
