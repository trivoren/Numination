# 🔗 IPC & DEEP LINKS — MOBILE VULNERABILITY GUIDE
# Inter-process communication and mobile deep links

═══════════════════════════════════════════════════════════════
              IPC MOBILE — UNDERSTANDING THE RISKS
═══════════════════════════════════════════════════════════════

IPC (Inter-Process Communication) on mobile:

  ANDROID                    iOS
  ──────────                 ───
  Intents (explicit/implicit)  URL Schemes
  Content Providers            Universal Links
  Broadcast Receivers          App Extensions
  Bound Services               XPC (system apps)
  Deep Links / App Links       Pasteboard

  EACH IPC MECHANISM = EXTERNAL ENTRY SURFACE
  → Data coming from OUTSIDE the app
  → Potentially controlled by an attacker
  → Must be treated as HOSTILE

═══════════════════════════════════════════════════════════════
              IPC AND DEEP LINK VULNERABILITIES
═══════════════════════════════════════════════════════════════

VULN-IPC-001 — Exported Android Activity Unprotected
  Severity: HIGH (CVSS 7.5)
  MASVS    : MASVS-PLATFORM-1
  
  Explanation:
    An Activity with android:exported="true"
    without permission protection can be launched
    by any other application.
    
    A malicious app can thus:
    → Launch sensitive Activities directly
    → Bypass the login screen
    → Access restricted features
  
  Detection:
    <activity
      android:name=".AdminActivity"
      android:exported="true"> <!-- Accessible to all apps! -->
      <intent-filter>...</intent-filter>
    </activity>
  
  Exploitation:
    // From a malicious app:
    Intent intent = new Intent()
    intent.setComponent(new ComponentName(
      "com.targetapp",
      "com.targetapp.AdminActivity"
    ))
    startActivity(intent)
  
  Fix:
    <!-- Option A: Don't export if unnecessary -->
    <activity
      android:name=".InternalActivity"
      android:exported="false" />
    
    <!-- Option B: Protect with a permission -->
    <activity
      android:name=".SensitiveActivity"
      android:exported="true"
      android:permission="com.yourapp.INTERNAL">
    </activity>
    
    <!-- Declare signature-level permission -->
    <permission
      android:name="com.yourapp.INTERNAL"
      android:protectionLevel="signature" />
    <!-- protectionLevel="signature" = only apps signed
         with the same key can send the intent -->

VULN-IPC-002 — Implicit Intent for Sensitive Data
  Severity: HIGH (CVSS 6.8)
  MASVS    : MASVS-PLATFORM-1
  
  Explanation:
    Implicit intents (without a specific target component)
    can be intercepted by other applications.
    
    If an implicit intent contains sensitive data
    (token, user data), a malicious app
    with the same intent-filter can intercept it.
  
  Detection:
    Intent intent = new Intent("com.yourapp.ACTION_SHARE_TOKEN")
    intent.putExtra("token", authToken) // Interceptable!
    sendBroadcast(intent)
  
  Fix:
    // Use EXPLICIT intents for sensitive data
    Intent intent = new Intent(context, TargetService.class)
    intent.putExtra("action", "doSomething")
    // No sensitive data in extras if broadcast
    startService(intent)
    
    // For broadcasts: use LocalBroadcastManager
    // or signature permissions
    LocalBroadcastManager.getInstance(context)
      .sendBroadcast(intent)

VULN-IPC-003 — Deep Link Without Parameter Validation
  Severity: HIGH (CVSS 7.1)
  MASVS    : MASVS-PLATFORM-2
  
  Explanation:
    Deep links can be triggered by:
    → An SMS or email received by the user
    → A web page (if autoVerify not configured)
    → Another application
    → A scanned QR code
    
    If parameters are not validated:
    → Route injection (navigation to any screen)
    → Parameter injection (IDOR, manipulated amounts)
    → Open redirect (redirection to malicious sites)
    → Execution of unwanted actions
  
  Exploitation:
    // Forged link sent via SMS:
    yourapp://transfer?to=attacker_account&amount=9999
    
    // If the app doesn't validate:
    → Transfer executed without additional confirmation
  
  Complete fix:
    // See REM-MOB-005 in MOBILE-REMEDIATION-LIBRARY.md

VULN-IPC-004 — URL Scheme Hijacking (iOS)
  Severity: HIGH (CVSS 6.5)
  MASVS    : MASVS-PLATFORM-2
  
  Explanation:
    On iOS, multiple apps can declare the same URL Scheme.
    Depending on installation order, a malicious app can
    intercept deep links intended for your app.
    
    Example: A fake app declares myapp://
    It receives deep links with reset tokens,
    OAuth auth codes, etc.
  
  Solution:
    → Universal Links (HTTPS) cannot be hijacked
    → They are linked to a domain that only your server
      can claim (AASA file)
    
    // iOS — Prefer Universal Links
    // 1. Host https://yourapp.com/.well-known/apple-app-site-association
    {
      "applinks": {
        "details": [{
          "appIDs": ["TEAMID.com.yourapp"],
          "components": [
            { "/": "/product/*" },
            { "/": "/order/*" },
            { "/": "/reset-password/*" }
          ]
        }]
      }
    }
    
    // 2. Info.plist — Associated Domains
    com.apple.developer.associated-domains :
      applinks:yourapp.com

VULN-IPC-005 — Unsecured WebView JavaScript Bridge
  Severity: CRITICAL (CVSS 8.8)
  MASVS    : MASVS-PLATFORM-4
  
  Explanation:
    A JavaScript Bridge exposes native functions
    to the WebView's JavaScript code.
    
    If the WebView loads untrusted content AND
    the bridge is too permissive:
    XSS in web content = access to native functions
    
  Detection:
    // React Native WebView with exposed bridge
    <WebView
      source={{ uri: dynamicUrl }} // Uncontrolled URL
      onMessage={handleAllMessages} // Accepts everything
    />
    
    // Handler doesn't validate origin
    const handleAllMessages = (event) => {
      const { action, data } = JSON.parse(event.nativeEvent.data)
      if (action === 'readFile') readFile(data.path) // Dangerous
    }
  
  Fix:
    <WebView
      // Strictly controlled URLs
      source={{ uri: 'https://trusted.yourapp.com' }}
      
      onShouldStartLoadWithRequest={(request) => {
        // Strict whitelist
        return request.url.startsWith(
          'https://trusted.yourapp.com'
        )
      }}
      
      onMessage={(event) => {
        let message
        try {
          message = JSON.parse(event.nativeEvent.data)
        } catch {
          return // Ignore invalid messages
        }
        
        // Whitelist of allowed actions
        const allowedActions = ['shareContent', 'goBack']
        if (!allowedActions.includes(message.action)) return
        
        // Validate data by action
        switch (message.action) {
          case 'shareContent':
            // Validate and sanitize content
            if (typeof message.text !== 'string') return
            shareContent(message.text.substring(0, 500))
            break
          case 'goBack':
            navigation.goBack()
            break
        }
      }}
    />
