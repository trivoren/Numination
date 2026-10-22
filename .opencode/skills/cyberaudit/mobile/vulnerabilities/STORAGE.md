# 💾 STORAGE — MOBILE VULNERABILITY GUIDE
# Mobile local storage vulnerabilities

═══════════════════════════════════════════════════════════════
              UNDERSTANDING MOBILE STORAGE
═══════════════════════════════════════════════════════════════

STORAGE SECURITY HIERARCHY
────────────────────────────

  LEVEL 1 — MOST SECURE (Hardware-backed)
    iOS  : Keychain with Secure Enclave
    Android: Keystore with StrongBox (if available)
    → Protected by dedicated hardware
    → Impossible to extract even with root
    → Bound to physical device

  LEVEL 2 — SECURE (Software-backed)
    iOS  : Standard Keychain
    Android: Software Keystore
    → Encrypted by the operating system
    → Hard to extract, requires advanced exploitation
    → Recommended for auth tokens

  LEVEL 3 — ACCEPTABLE (with app-level encryption)
    MMKV encrypted, Hive encrypted, SQLCipher
    → Encrypted by the application itself
    → Safe if key is in Level 1 or 2
    → Risky if key is in code

  LEVEL 4 — DANGEROUS (unencrypted)
    AsyncStorage, SharedPreferences, UserDefaults,
    localStorage, sessionStorage, unencrypted SQLite
    → Readable directly on rooted/jailbroken device
    → Extractable via ADB backup (Android)
    → Never use for sensitive data

DATA CONSIDERED SENSITIVE
───────────────────────────────
  → Authentication tokens (JWT, session tokens)
  → Refresh tokens
  → Passwords (even hashed client-side)
  → Cryptographic keys
  → Credit card numbers
  → Health data (HIPAA)
  → Personally identifiable information (GDPR)
  → PIN codes / secret codes

═══════════════════════════════════════════════════════════════
              DETAILED VULNERABILITIES
═══════════════════════════════════════════════════════════════

VULN-STORAGE-001 — Sensitive data in AsyncStorage
  Severity: HIGH (CVSS 6.8)
  MASVS    : MASVS-STORAGE-1
  
  Explanation:
    AsyncStorage stores data in unencrypted files
    in the application directory.
    On rooted Android:
      /data/data/com.yourapp/databases/AsyncStorage
    On jailbroken iOS:
      NSLibraryDirectory/RCTAsyncLocalStorage_V1/
    
    These files are readable in seconds
    with the appropriate tools.
  
  Detection:
    AsyncStorage.setItem(key, value) where value contains
    a token, password, or sensitive data.
  
  Exploitation:
    1. Rooted device
    2. adb shell
    3. cat /data/data/com.app/databases/AsyncStorage*
    4. Read cleartext token
  
  Fix: See REM-MOB-001

VULN-STORAGE-002 — Unprotected Android Backup
  Severity: HIGH (CVSS 6.2)
  MASVS    : MASVS-STORAGE-3
  
  Explanation:
    By default: android:allowBackup="true"
    An ADB backup can be performed without root
    if USB debugging is enabled.
    
    Even without USB debugging, cloud backups (Google)
    may include app data.
  
  Detection:
    android:allowBackup="true" in AndroidManifest.xml
    OR absence of backup_rules.xml
  
  Exploitation:
    adb backup -apk com.yourapp -f backup.ab
    java -jar abe.jar unpack backup.ab backup.tar
    tar xf backup.tar
    ls apps/com.yourapp/
    # All app data is there
  
  Fix:
    <application android:allowBackup="false" />
    <!-- OR with selective backup rules -->
    <application
      android:fullBackupContent="@xml/backup_rules"
      android:dataExtractionRules="@xml/data_extraction_rules">
    
    <!-- backup_rules.xml -->
    <full-backup-content>
      <exclude domain="sharedpref" path="." />
      <exclude domain="database" path="." />
      <exclude domain="file" path="sensitive/" />
    </full-backup-content>

VULN-STORAGE-003 — Screenshots in Task Switcher
  Severity: MEDIUM (CVSS 4.0)
  MASVS    : MASVS-STORAGE-4
  
  Explanation:
    When the user puts the app in background,
    Android and iOS capture a screenshot for
    display in the task switcher.
    
    This screenshot may contain:
    → Bank balance
    → Private messages
    → Medical data
    → Personal information
    
    On a shared or stolen device, these screenshots
    are accessible.
  
  Fix:
    Android — FLAG_SECURE in MainActivity:
      getWindow().setFlags(
        WindowManager.LayoutParams.FLAG_SECURE,
        WindowManager.LayoutParams.FLAG_SECURE
      )
    
    iOS — Overlay when backgrounding:
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(appDidBecomeInactive),
        name: UIApplication.willResignActiveNotification,
        object: nil
      )
    
    React Native — See REM-MOB-003

VULN-STORAGE-004 — Sensitive data in logs
  Severity: MEDIUM (CVSS 5.5)
  MASVS    : MASVS-STORAGE-2
  
  Explanation:
    System logs on Android are accessible via:
      adb logcat
    Without root, only your own app logs.
    With root, all system logs.
    
    Tools like LogCat Reader can read
    other apps' logs on some older devices.
  
  Detection:
    console.log, print, NSLog with tokens, passwords,
    user data, complete API responses.
  
  Fix: See REM-MOB-004

VULN-STORAGE-005 — Unencrypted SQLite Database
  Severity: HIGH (CVSS 6.8)
  MASVS    : MASVS-STORAGE-1
  
  Explanation:
    An unencrypted SQLite DB is an ordinary file.
    On rooted device, directly readable:
      adb shell
      sqlite3 /data/data/com.app/databases/app.db
      .dump
    
    Or extracted via backup and opened with DB Browser for SQLite.
  
  Fix:
    React Native: react-native-sqlite-storage + SQLCipher
    Flutter      : sqflite_sqlcipher
    Ionic        : Ionic Secure Storage
    
    // React Native with SQLCipher
    import SQLite from 'react-native-sqlite-storage'
    SQLite.enablePromise(true)
    
    const db = await SQLite.openDatabase({
      name: 'app.db',
      key: await getEncryptionKeyFromKeychain(),
      // The key comes from Keychain, not code!
    })
