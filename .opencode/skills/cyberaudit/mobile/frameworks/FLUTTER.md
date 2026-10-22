# 🦋 FLUTTER — SECURITY AUDIT GUIDE
# Comprehensive audit guide for Flutter/Dart applications

═══════════════════════════════════════════════════════════════
              FLUTTER THREAT MODEL
═══════════════════════════════════════════════════════════════

FLUTTER ARCHITECTURE AND SECURITY IMPLICATIONS
──────────────────────────────────────────────

  [Dart Code]  →  [Flutter Engine (C++)]  →  [Platform APIs]
      ↑                    ↑                       ↑
  Business logic      Rendering              Native iOS/Android
  UI + State          Skia/Impeller         Storage, Camera...

  POINTS TO WATCH:
  → Dart code is compiled AOT (Ahead-of-Time)
    = less readable than a JS bundle but analysable
  → Dart strings can still be extracted from the binary
  → Platform channels = bridge between Dart and native
    = attack surface if poorly validated
  → Flutter Web = additional classic web attack surface

FLUTTER ATTACK SURFACE
──────────────────────────
  LAYER 1 — LOCAL STORAGE
    SharedPreferences, Hive, Isar, sqflite, path_provider
  
  LAYER 2 — NETWORK
    http, dio, chopper — no pinning by default
  
  LAYER 3 — PLATFORM CHANNELS
    MethodChannel, EventChannel — Dart/native bridge
  
  LAYER 4 — WEBVIEW
    webview_flutter — XSS surface if uncontrolled content
  
  LAYER 5 — DART BINARY
    Extractable strings, endpoints, business logic

═══════════════════════════════════════════════════════════════
              VULNERABLE FLUTTER PATTERNS
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
UNSECURE STORAGE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 1 — SharedPreferences with sensitive data
  DETECT:
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('auth_token', token);
    await prefs.setString('password', password);
    await prefs.setString('user_data', jsonEncode(user));
  
  FIX:
    // pubspec.yaml
    // dependencies:
    //   flutter_secure_storage: ^9.0.0
    
    import 'package:flutter_secure_storage/flutter_secure_storage.dart';
    
    const _storage = FlutterSecureStorage(
      aOptions: AndroidOptions(
        encryptedSharedPreferences: true,
        // Uses Android EncryptedSharedPreferences
        keyCipherAlgorithm:
          KeyCipherAlgorithm.RSA_ECB_OAEPwithSHA_256andMGF1Padding,
        storageCipherAlgorithm:
          StorageCipherAlgorithm.AES_GCM_NoPadding,
      ),
      iOptions: IOSOptions(
        accessibility: KeychainAccessibility.first_unlock_this_device,
        // first_unlock_this_device = not in iCloud backups
      ),
    );
    
    // Store
    await _storage.write(key: 'auth_token', value: token);
    
    // Read
    final token = await _storage.read(key: 'auth_token');
    
    // Delete (logout)
    await _storage.delete(key: 'auth_token');
    
    // Delete all
    await _storage.deleteAll();

HIGH PATTERN 2 — Hive without encryption
  DETECT:
    await Hive.initFlutter();
    final box = await Hive.openBox('userData');
    await box.put('token', authToken);
    await box.put('user', user.toMap());
  
  FIX:
    import 'package:hive_flutter/hive_flutter.dart';
    import 'package:flutter_secure_storage/flutter_secure_storage.dart';
    
    Future<Box> openEncryptedBox(String boxName) async {
      const secureStorage = FlutterSecureStorage();
      
      // Generate or retrieve encryption key
      var encryptionKeyString =
          await secureStorage.read(key: 'hive_key_$boxName');
      
      late List<int> encryptionKey;
      
      if (encryptionKeyString == null) {
        // Generate a secure key
        final key = Hive.generateSecureKey();
        encryptionKey = key;
        await secureStorage.write(
          key: 'hive_key_$boxName',
          value: base64UrlEncode(key),
        );
      } else {
        encryptionKey = base64Url.decode(encryptionKeyString);
      }
      
      return Hive.openBox(
        boxName,
        encryptionCipher: HiveAesCipher(encryptionKey),
      );
    }
    
    // Usage
    final box = await openEncryptedBox('secure_user_data');
    await box.put('token', token);

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NETWORK — CERTIFICATE PINNING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 3 — Dio without pinning
  DETECT:
    final dio = Dio();
    // No pinning configuration
    final response = await dio.get('/api/users');
  
  FIX:
    import 'package:dio/dio.dart';
    import 'dart:io';
    
    Dio createSecureDio() {
      final dio = Dio(
        BaseOptions(
          baseUrl: 'https://api.yourapp.com',
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 30),
          headers: {
            'Content-Type': 'application/json',
          },
        ),
      );
      
      // Certificate pinning via custom HttpClient
      (dio.httpClientAdapter as DefaultHttpClientAdapter)
        .onHttpClientCreate = (client) {
          
          client.badCertificateCallback = (
            X509Certificate cert,
            String host,
            int port,
          ) {
            // Verify SHA-256 of certificate
            final expectedFingerprints = [
              'AA:BB:CC:DD:...', // Primary pin
              'EE:FF:00:11:...', // Backup pin (MANDATORY)
            ];
            
            final certFingerprint = _getCertFingerprint(cert);
            return expectedFingerprints.contains(certFingerprint);
          };
          
          return client;
        };
      
      // Interceptor to add token
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) async {
            final token = await _getSecureToken();
            if (token != null) {
              options.headers['Authorization'] = 'Bearer $token';
            }
            handler.next(options);
          },
          onError: (error, handler) {
            // Do not log sensitive details
            logger.error(
              'API Error: ${error.response?.statusCode}',
            );
            handler.next(error);
          },
        ),
      );
      
      return dio;
    }
    
    String _getCertFingerprint(X509Certificate cert) {
      final digest = sha256.convert(cert.der);
      return digest.bytes
          .map((b) => b.toRadixString(16).padLeft(2, '0').toUpperCase())
          .join(':');
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HARDCODED DART SECRETS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 4 — Secret constants in Dart code
  DETECT:
    const String apiKey = 'sk-abc123...';
    const String dbPassword = 'supersecret';
    static const baseUrl = 'https://internal.corp.com/api';
    
    class Config {
      static const stripeKey = 'sk_live_...'; // CRITICAL
    }
  
  UNDERSTAND:
    Even compiled, Dart strings are extractable:
    strings app.aot | grep -i "api\|key\|secret\|password"
    
  FIX:
    // Option A: --dart-define at build time
    // flutter build apk --dart-define=API_KEY=xxx
    
    class Config {
      static const apiKey =
          String.fromEnvironment('API_KEY', defaultValue: '');
      
      // Validate at startup
      static void validate() {
        if (apiKey.isEmpty) {
          throw Exception(
            'API_KEY must be provided via --dart-define'
          );
        }
      }
    }
    
    // Option B: Fetch from secure backend
    // on first launch (after auth)
    
    // Option C: flutter_dotenv for development
    // (NEVER real keys in prod)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LOGS IN PRODUCTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MEDIUM PATTERN 5 — print() and debugPrint() in production
  DETECT:
    print('User token: $token');
    debugPrint('Auth response: $response');
    print(user.toJson()); // PII data
  
  FIX:
    // lib/core/logger.dart
    import 'package:flutter/foundation.dart';
    
    class AppLogger {
      static void debug(String message) {
        if (kDebugMode) debugPrint('[DEBUG] $message');
      }
      
      static void info(String message) {
        if (kDebugMode) debugPrint('[INFO] $message');
      }
      
      static void warn(String message) {
        if (kDebugMode) debugPrint('[WARN] $message');
      }
      
      static void error(
        String message, [
        Object? error,
        StackTrace? stackTrace,
      ]) {
        if (kDebugMode) {
          debugPrint('[ERROR] $message');
          if (error != null) debugPrint(error.toString());
        }
        
        // In production: Crashlytics without sensitive data
        FirebaseCrashlytics.instance.recordError(
          error ?? message,
          stackTrace,
          reason: message,
          // Do not include user data
        );
      }
      
      // Intentional no-op for sensitive data
      static void sensitive(String message) {}
    }

═══════════════════════════════════════════════════════════════
              COMPLETE FLUTTER CHECKLIST
═══════════════════════════════════════════════════════════════

STORAGE
  □ SharedPreferences without sensitive data ?
  □ flutter_secure_storage for tokens and secrets ?
  □ Hive with encryption if sensitive data ?
  □ sqflite with SQLCipher if sensitive data ?
  □ Encryption keys in secure_storage ?

NETWORK
  □ Dio with certificate pinning ?
  □ Backup pin configured ?
  □ Timeout configured (connect + receive) ?
  □ Tokens in headers via interceptor ?
  □ Error logs without sensitive data ?

CODE
  □ No secret constants in Dart code ?
  □ --dart-define used for sensitive configs ?
  □ kDebugMode for print() ?
  □ Release mode tested (flutter build --release) ?
  □ ProGuard enabled for native code (Android) ?

PLATFORM
  □ Secured AndroidManifest ?
  □ Info.plist minimal permissions ?
  □ flutter_secure_storage options configured ?
  □ allowBackup=false (Android) ?
  □ Keyboard cache disabled on sensitive fields ?

DEPENDENCIES
  □ pub audit executed ?
  □ Packages up to date ?
  □ pubspec.lock committed ?
  □ Firebase/analytics SDK: minimal data ?
