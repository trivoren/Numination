# ⚛️ REACT NATIVE — SECURITY AUDIT GUIDE
# Comprehensive audit guide for React Native applications

═══════════════════════════════════════════════════════════════
              REACT NATIVE — SECURITY ARCHITECTURE
═══════════════════════════════════════════════════════════════

UNDERSTANDING THE ARCHITECTURE TO AUDIT CORRECTLY
─────────────────────────────────────────────────────

  [JavaScript Thread]  ←→  [Bridge / JSI]  ←→  [Native Thread]
         ↑                                              ↑
  React Native Code                          Native modules
  Business logic                             System APIs
  App state                                  Storage, Camera...

  SECURITY IMPLICATIONS:
  → The JS bundle is packaged in the app = extractable
  → The Bridge = attack surface between JS and native
  → Expo managed = less control over native modules
  → Bare workflow = more control, more responsibility

═══════════════════════════════════════════════════════════════
              VULNERABLE REACT NATIVE PATTERNS
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UNSECURE STORAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 1 — AsyncStorage with sensitive data
  DETECT:
    AsyncStorage.setItem('token', accessToken)
    AsyncStorage.setItem('user_data', JSON.stringify(user))
    AsyncStorage.setItem('password', password)
    AsyncStorage.setItem('credit_card', cardNumber)
    AsyncStorage.setItem('session', sessionId)
    
    // Also via wrappers:
    storage.set('auth', token)  // if storage = AsyncStorage
    cache.store('user', data)   // check implementation

  UNDERSTAND:
    AsyncStorage = unencrypted files on the system
    Android: /data/data/com.yourapp/databases/
    iOS: NSLibraryDirectory unencrypted
    Readable with root/jailbreak OR unencrypted backup
  
  FIX:
    // Installation
    // yarn add react-native-keychain
    
    import * as Keychain from 'react-native-keychain'
    
    // Store the auth token
    await Keychain.setGenericPassword(
        'auth-token',
        accessToken,
        {
            service: 'com.yourapp.auth',
            accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
            accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            // WHEN_UNLOCKED_THIS_DEVICE_ONLY = not in iCloud backups
        }
    )
    
    // Retrieve the token
    const credentials = await Keychain.getGenericPassword({
        service: 'com.yourapp.auth'
    })
    const token = credentials ? credentials.password : null
    
    // For less sensitive data (preferences, config)
    // react-native-encrypted-storage is acceptable
    import EncryptedStorage from 'react-native-encrypted-storage'
    
    await EncryptedStorage.setItem(
        'user_preferences',
        JSON.stringify(preferences)
    )

HIGH PATTERN 2 — MMKV / Redux Persist without encryption
  DETECT:
    import { MMKV } from 'react-native-mmkv'
    const storage = new MMKV() // No encryption!
    storage.set('user.token', token)
    
    // Redux Persist with AsyncStorage
    const persistConfig = {
        key: 'root',
        storage: AsyncStorage, // Unencrypted!
        // Whitelist without filtering sensitive data
        whitelist: ['auth', 'user', 'payment']
    }
  
  FIX:
    // MMKV with encryption
    import { MMKV } from 'react-native-mmkv'
    
    // Encryption key must come from Keychain!
    const encryptionKey = await getEncryptionKeyFromKeychain()
    
    const storage = new MMKV({
        id: 'secure-storage',
        encryptionKey: encryptionKey
    })
    
    // Redux Persist: do NOT persist sensitive data
    const persistConfig = {
        key: 'root',
        storage: MMKVStorage, // with encryption
        // Blacklist sensitive data
        blacklist: ['auth', 'payment'],
        // OR whitelist only what is safe
        whitelist: ['ui', 'settings', 'theme']
    }
    
    // Auth tokens → Keychain only

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UNSECURE WEBVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 3 — WebView with exposed JS bridge
  DETECT:
    <WebView
        source={{ uri: userUrl }}        // User-controlled URL!
        javaScriptEnabled={true}
        onMessage={handleMessage}        // Exposed bridge
    />
    
    // Even worse:
    <WebView
        source={{ uri: `https://yourapp.com?data=${userInput}` }}
        injectedJavaScript={userScript}  // CRITICAL
    />
  
  FIX:
    <WebView
        // Controlled source
        source={{ uri: 'https://trusted.yourapp.com/content' }}
        
        // If dynamic URL, strict whitelist
        onShouldStartLoadWithRequest={(request) => {
            const allowedHosts = ['yourapp.com', 'trusted-partner.com']
            const host = new URL(request.url).hostname
            return allowedHosts.includes(host)
        }}
        
        // Messages validated on React Native side
        onMessage={(event) => {
            const data = JSON.parse(event.nativeEvent.data)
            
            // Validate message type
            const allowedTypes = ['navigation', 'shareContent', 'payment_result']
            if (!allowedTypes.includes(data.type)) return
            
            // Validate data by type
            handleValidatedMessage(data)
        }}
        
        // Disable JS if not needed
        javaScriptEnabled={false} // If possible
        
        // Disable local file access
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
    />

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LOGS IN PRODUCTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MEDIUM PATTERN 4 — console.log with sensitive data
  DETECT:
    console.log('User logged in:', user)
    console.log('Token:', token)
    console.log('API Response:', response.data)
    console.log('Payment data:', paymentInfo)
    console.warn('Auth error:', authError) // contains details?
    
    // Often forgotten patterns:
    console.log(JSON.stringify(reduxState)) // Full state!
    console.log('Request:', config) // Headers with auth token!
  
  FIX:
    // utils/logger.ts
    const isDev = __DEV__
    
    export const logger = {
        // Log only in development
        debug: (...args: any[]) => {
            if (isDev) console.log('[DEBUG]', ...args)
        },
        
        info: (...args: any[]) => {
            if (isDev) console.info('[INFO]', ...args)
        },
        
        warn: (...args: any[]) => {
            if (isDev) console.warn('[WARN]', ...args)
        },
        
        // Errors can go to crash reporting service
        // but WITHOUT sensitive data
        error: (message: string, error?: Error) => {
            if (isDev) console.error('[ERROR]', message, error)
            
            // In production: send only message, not data
            crashReporter.log(message, {
                errorType: error?.name,
                // No full stack trace with user data
            })
        },
        
        // Never log this data, even in dev
        sensitive: () => {
            // Intentional no-op
        }
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REACT NATIVE DEEP LINKS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 5 — Deep links without validation
  DETECT:
    // Basic handling without validation
    Linking.addEventListener('url', ({ url }) => {
        const route = url.replace('myapp://', '')
        navigation.navigate(route) // ROUTE INJECTION
    })
    
    // React Navigation without validation
    const config = {
        screens: {
            Payment: 'payment/:amount',  // amount not validated!
            Profile: 'user/:userId',      // IDOR possible!
        }
    }
  
  FIX:
    import { Linking } from 'react-native'
    
    // Complete deep link validation
    const handleDeepLink = async (url: string) => {
        // 1. Parse URL
        let parsed: URL
        try {
            parsed = new URL(url)
        } catch {
            return // Invalid URL
        }
        
        // 2. Verify allowed scheme
        const allowedSchemes = ['myapp:', 'https:']
        if (!allowedSchemes.includes(parsed.protocol)) return
        
        // 3. If HTTPS, verify host
        if (parsed.protocol === 'https:') {
            const allowedHosts = ['yourapp.com', 'app.yourapp.com']
            if (!allowedHosts.includes(parsed.hostname)) return
        }
        
        // 4. Route to allowed screens
        const path = parsed.pathname.split('/').filter(Boolean)
        
        switch (path[0]) {
            case 'product': {
                const productId = parseInt(path[1], 10)
                if (isNaN(productId) || productId <= 0) return
                navigation.navigate('Product', { id: productId })
                break
            }
            
            case 'payment': {
                // Sensitive routes require auth
                const session = await getCurrentSession()
                if (!session) {
                    navigation.navigate('Login', { returnTo: url })
                    return
                }
                // Parameters validated server-side, not client-side
                navigation.navigate('Payment')
                break
            }
            
            case 'reset-password': {
                const token = parsed.searchParams.get('token')
                // Opaque token, validated by server
                if (!token || token.length < 32) return
                navigation.navigate('ResetPassword', { token })
                break
            }
            
            default:
                // Unknown route → ignore
                return
        }
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REACT NATIVE CERTIFICATE PINNING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 6 — No certificate pinning
  DETECT:
    // Standard fetch without pinning
    fetch('https://api.yourapp.com/users')
    
    // Axios without pinning
    axios.get('https://api.yourapp.com/data')
    
    // None of the following libraries imported:
    // react-native-ssl-pinning
    // react-native-pinch
    // No native pinning module
  
  FIX:
    // Installation
    // yarn add react-native-ssl-pinning
    
    import { fetch as sslFetch } from 'react-native-ssl-pinning'
    
    // Get certificate hash:
    // openssl s_client -connect api.yourapp.com:443 | \
    //   openssl x509 -pubkey -noout | \
    //   openssl pkey -pubin -outform der | \
    //   openssl dgst -sha256 -binary | base64
    
    const API_PINS = [
        'YOUR_PRIMARY_PIN_BASE64==',
        'YOUR_BACKUP_PIN_BASE64==',  // Always have a backup!
    ]
    
    export const secureApi = {
        get: async (endpoint: string, options = {}) => {
            return sslFetch(`https://api.yourapp.com${endpoint}`, {
                method: 'GET',
                sslPinning: {
                    certs: API_PINS,
                },
                headers: {
                    'Authorization': `Bearer ${await getToken()}`,
                    'Content-Type': 'application/json',
                },
                ...options,
            })
        },
        
        post: async (endpoint: string, body: object) => {
            return sslFetch(`https://api.yourapp.com${endpoint}`, {
                method: 'POST',
                sslPinning: {
                    certs: API_PINS,
                },
                body: JSON.stringify(body),
                headers: {
                    'Authorization': `Bearer ${await getToken()}`,
                    'Content-Type': 'application/json',
                },
            })
        }
    }
    
    // IMPORTANT: Pin rotation plan
    // 1. Generate new pins 30 days before expiration
    // 2. Deploy app with [old pin, new pin]
    // 3. Wait >95% of users have migrated
    // 4. Deploy app with [new pin] only

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BACKGROUND SCREENSHOT (iOS/Android)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MEDIUM PATTERN 7 — Sensitive data visible in switcher
  DETECT:
    // No background screenshot protection
    // No AppState listener to hide data
    // No FLAG_SECURE (Android) or blurring (iOS)
  
  FIX:
    import { AppState, Platform } from 'react-native'
    import { useEffect, useState } from 'react'
    
    // Background protection hook
    export const useBackgroundProtection = () => {
        const [isBackground, setIsBackground] = useState(false)
        
        useEffect(() => {
            const subscription = AppState.addEventListener(
                'change',
                (nextAppState) => {
                    setIsBackground(nextAppState === 'background' || 
                                   nextAppState === 'inactive')
                }
            )
            
            return () => subscription.remove()
        }, [])
        
        return isBackground
    }
    
    // Protection component
    export const ProtectedScreen = ({ children }) => {
        const isBackground = useBackgroundProtection()
        
        if (isBackground) {
            return (
                <View style={styles.blurScreen}>
                    <Image source={require('./assets/logo.png')} />
                    // Masks content with app logo
                </View>
            )
        }
        
        return children
    }
    
    // Android: FLAG_SECURE (prevents screenshots)
    // In MainActivity.java:
    // getWindow().setFlags(
    //     WindowManager.LayoutParams.FLAG_SECURE,
    //     WindowManager.LayoutParams.FLAG_SECURE
    // );
    
    // Library: react-native-screenshot-prevent

═══════════════════════════════════════════════════════════════
              COMPLETE REACT NATIVE CHECKLIST
═══════════════════════════════════════════════════════════════

STORAGE
  □ AsyncStorage without sensitive data ?
  □ Keychain for tokens and passwords ?
  □ MMKV with encryption if used ?
  □ Redux Persist: sensitive data blacklisted ?
  □ SQLite encrypted (SQLCipher) if local database ?

NETWORK
  □ Certificate pinning implemented ?
  □ Backup pins present ?
  □ All endpoints in HTTPS ?
  □ Tokens in headers, not query params ?
  □ Network Security Config (Android) configured ?

WEBVIEW
  □ URLs strictly whitelisted ?
  □ javaScriptEnabled justified ?
  □ WebView messages validated ?
  □ allowFileAccess=false ?
  □ JavaScript Bridge minimal and secure ?

CODE
  □ console.log disabled in production ?
  □ __DEV__ used for debug logs ?
  □ No API keys in JS code ?
  □ Source maps disabled in production ?
  □ Hermes enabled (Android) ?

DEEP LINKS
  □ All parameters validated ?
  □ Allowed routes whitelisted ?
  □ Auth checked before sensitive actions ?
  □ Minimal intent filters (Android) ?

INTERFACE
  □ Screenshot protection in background ?
  □ Sensitive fields with secureTextEntry ?
  □ Clipboard protection on sensitive data ?
  □ Autocomplete disabled on sensitive fields ?

BUILD
  □ ProGuard/R8 enabled in Android release ?
  □ Debug builds separate from release builds ?
  □ Signing config secured ?
  □ Dependencies audited ?
