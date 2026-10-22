# 🔒 CRYPTO MOBILE — VULNERABILITY GUIDE
# Cryptography in mobile applications

═══════════════════════════════════════════════════════════════
              MOBILE CRYPTOGRAPHY — PRINCIPLES
═══════════════════════════════════════════════════════════════

GOLDEN RULES OF MOBILE CRYPTOGRAPHY
────────────────────────────────────────
  1. Use platform cryptographic APIs
     → iOS: CryptoKit, CommonCrypto, Security Framework
     → Android: Keystore System, javax.crypto
     → Never implement your own crypto

  2. Store keys in cryptographic hardware
     → iOS: Secure Enclave (A7+)
     → Android: StrongBox Keymaster (if available)
     → Otherwise: Software Keystore

  3. Approved algorithms only
     → Symmetric: AES-256-GCM (authenticated)
     → Asymmetric: RSA-2048+, ECDSA P-256+
     → Hashing: SHA-256+
     → KDF: PBKDF2, bcrypt, argon2
     → NEVER: DES, 3DES, RC4, MD5, SHA1

  4. Secure random generation
     → iOS: SecRandomCopyBytes
     → Android: SecureRandom (via Keystore)
     → Never Math.random() for crypto

═══════════════════════════════════════════════════════════════
              MOBILE CRYPTO VULNERABILITIES
═══════════════════════════════════════════════════════════════

VULN-CRYPTO-001 — Weak Cryptographic Algorithms
  Severity: CRITICAL (CVSS 9.1)
  MASVS    : MASVS-CRYPTO-1
  
  Detection:
    // React Native / JS
    const hash = CryptoJS.MD5(password)      // CRITICAL
    const hash = CryptoJS.SHA1(data)         // CRITICAL
    const cipher = CryptoJS.DES.encrypt()    // CRITICAL
    const cipher = CryptoJS.RC4.encrypt()    // CRITICAL
    
    // Dart / Flutter
    import 'package:crypto/crypto.dart';
    final hash = md5.convert(bytes)          // CRITICAL
    final hash = sha1.convert(bytes)         // Weak
    
    // Java / Kotlin (Android)
    MessageDigest.getInstance("MD5")         // CRITICAL
    Cipher.getInstance("DES")               // CRITICAL
    Cipher.getInstance("AES/ECB/PKCS5Padding") // ECB = vulnerable
  
  Fix:
    // React Native — Use expo-crypto or react-native-quick-crypto
    import * as Crypto from 'expo-crypto'
    
    const hash = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256, // SHA-256 minimum
      data
    )
    
    // For encryption: AES-GCM via react-native-quick-crypto
    import { createCipheriv, randomBytes } from
      'react-native-quick-crypto'
    
    const encrypt = (plaintext: string, key: Buffer): Buffer => {
      const iv = randomBytes(12) // 96 bits for GCM
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ])
      
      const tag = cipher.getAuthTag() // GCM authentication tag
      
      // Store: iv (12) + tag (16) + encrypted
      return Buffer.concat([iv, tag, encrypted])
    }

VULN-CRYPTO-002 — Hardcoded Cryptographic Key
  Severity: CRITICAL (CVSS 9.1)
  MASVS    : MASVS-CRYPTO-5
  
  Detection:
    const ENCRYPTION_KEY = 'MySecretKey12345'         // CRITICAL
    const KEY = Buffer.from('aabbccdd...', 'hex')     // CRITICAL
    static final byte[] KEY = {0x41, 0x42, ...}       // CRITICAL
    
    // Flutter
    const encryptionKey = 'hardcoded-secret-key'      // CRITICAL
  
  Fix:
    // The key must be:
    // 1. Randomly generated (not hardcoded)
    // 2. Stored in Keychain/Keystore
    // 3. Never in source code
    
    // React Native — Secure generation and storage
    import * as Keychain from 'react-native-keychain'
    import { randomBytes } from 'react-native-quick-crypto'
    
    const getOrCreateEncryptionKey = async (): Promise<Buffer> => {
      const KEY_SERVICE = 'com.yourapp.encryption-key'
      
      // Try to retrieve existing key
      const existing = await Keychain.getGenericPassword({
        service: KEY_SERVICE,
      })
      
      if (existing) {
        return Buffer.from(existing.password, 'hex')
      }
      
      // Generate new key (first use)
      const newKey = randomBytes(32) // 256 bits for AES-256
      
      await Keychain.setGenericPassword(
        'encryption-key',
        newKey.toString('hex'),
        {
          service: KEY_SERVICE,
          accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }
      )
      
      return newKey
    }

VULN-CRYPTO-003 — Static or Predictable IV/Nonce
  Severity: HIGH (CVSS 7.5)
  MASVS    : MASVS-CRYPTO-3
  
  Explanation:
    The IV (Initialization Vector) or Nonce must be:
    → Random and unique for EACH encryption operation
    → Never reused with the same key (especially in GCM)
    
    A static IV allows:
    → Pattern analysis in encrypted data
    → Birthday attacks
    → In GCM: key recovery if IV reused!
  
  Detection:
    const iv = Buffer.from('1234567890123456') // CRITICAL: static
    const iv = Buffer.alloc(16, 0)             // CRITICAL: zeros
    const iv = Buffer.from(userId, 'hex')      // HIGH: predictable
  
  Fix:
    // ALWAYS generate a random IV
    const iv = randomBytes(12) // 12 bytes for AES-GCM
    
    // Store IV with encrypted data
    // IV is NOT secret but must be unique
    const stored = Buffer.concat([iv, encrypted, authTag])

VULN-CRYPTO-004 — Insecure Random Generation
  Severity: HIGH (CVSS 7.5)
  MASVS    : MASVS-CRYPTO-3
  
  Detection:
    Math.random()                    // NEVER for crypto
    Math.floor(Math.random() * ...)  // NEVER
    new Date().getTime()             // NEVER as seed
    
    // Java
    new Random()                     // NEVER
    new Random(System.currentTimeMillis()) // NEVER
  
  Fix:
    // JavaScript / React Native
    import { randomBytes } from 'react-native-quick-crypto'
    // OR
    import * as Crypto from 'expo-crypto'
    const randomValue = Crypto.getRandomBytes(32)
    
    // Dart / Flutter
    import 'dart:math';
    final random = Random.secure() // .secure() = CSPRNG
    final bytes = List<int>.generate(
      32, (_) => random.nextInt(256)
    )
    
    // Java / Kotlin (Android)
    import java.security.SecureRandom
    val random = SecureRandom()
    val bytes = ByteArray(32)
    random.nextBytes(bytes)
