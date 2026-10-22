# 🔐 PERMISSIONS — MOBILE VULNERABILITY GUIDE
# Mobile permissions audit

═══════════════════════════════════════════════════════════════
              PERMISSIONS PHILOSOPHY
═══════════════════════════════════════════════════════════════

EVERY PERMISSION IS A PROMISE TO THE USER
────────────────────────────────────────────────────
  By requesting a permission, you promise:
  → I will use this capability ONLY for what I told you
  → I will access your data ONLY when necessary
  → I will not share your data without your consent
  
  An unnecessary permission = a promise you won't keep.
  
SENSITIVE PERMISSIONS AND THEIR RISKS
────────────────────────────────────────
  CAMERA
    Risk: Camera access at any time
    Legitimate use: QR scan, profile photo
    Possible abuse: Non-consensual surveillance
  
  MICROPHONE
    Risk: Audio recording in background
    Legitimate use: Voice calls, audio notes
    Possible abuse: Conversation eavesdropping
  
  LOCATION
    Risk: Real-time movement tracking
    Legitimate use: Navigation, delivery
    Possible abuse: Surveillance, profiling
    Fine vs Coarse: Choose the least precise possible
  
  CONTACTS
    Risk: Access to entire address book
    Legitimate use: Invite friends
    Possible abuse: Email harvesting, spam
  
  STORAGE / FILES
    Risk: Access to all device files
    Legitimate use: Select a photo
    Possible abuse: Document theft, private photos
    Android 13+: Photo Picker without storage permission
  
  BACKGROUND LOCATION
    Risk: Permanent tracking even app closed
    Legitimate use: GPS navigation in background
    Possible abuse: 24/7 surveillance
  
  READ_CALL_LOG / SEND_SMS
    Risk: Access to communications
    Legitimate use: Very rare
    Possible abuse: OTP SMS theft, surveillance

═══════════════════════════════════════════════════════════════
              VULNERABLE PERMISSIONS PATTERNS
═══════════════════════════════════════════════════════════════

VULN-PERM-001 — Excessive declared permissions
  Severity: MEDIUM (CVSS 4.3)
  MASVS    : MASVS-PLATFORM-7
  
  Detection:
    AndroidManifest.xml:
    <uses-permission android:name="android.permission.READ_CONTACTS"/>
    <uses-permission android:name="android.permission.SEND_SMS"/>
    <uses-permission android:name="android.permission.CAMERA"/>
    → Verify if each is ACTUALLY used in the code
  
  Fix:
    1. List all declared permissions
    2. For each permission:
       - Search for its usage in code
       - If not found → remove
    3. Use less invasive alternatives:
       - Storage → SAF (Storage Access Framework) Android
       - Photo → Photo Picker (Android 13+, iOS 14+)
       - Location → Coarse if Fine not needed

VULN-PERM-002 — Permission requested at startup (UX and security)
  Severity: LOW (CVSS 2.0)
  MASVS    : MASVS-PLATFORM-7
  
  Explanation:
    Asking all permissions at startup:
    → Poor UX (user reflexively refuses)
    → Impossible to justify contextually
    → User doesn't understand why
    → High refusal rate = broken features
  
  Fix:
    // Request at time of need with explanation
    
    const requestCameraPermission = async () => {
      // 1. Explain why BEFORE asking
      const shouldRequest = await showExplanationDialog({
        title: 'Camera access',
        message: 'To scan your ticket QR code, '
               + 'we need access to your camera.',
        confirmText: 'Allow',
        cancelText: 'Not now',
      })
      
      if (!shouldRequest) return false
      
      // 2. Request permission
      const { status } = await Camera.requestCameraPermissionsAsync()
      
      // 3. Handle refusal gracefully
      if (status !== 'granted') {
        showAlternativeOptions() // Offer an alternative
        return false
      }
      
      return true
    }

VULN-PERM-003 — App crash if permission denied
  Severity: MEDIUM (CVSS 4.0)
  MASVS    : MASVS-PLATFORM-7
  
  Detection:
    // No handling for "permission denied" case
    const { status } = await requestPermission()
    // Direct usage without checking status
    const photo = await takePicture() // Crash if denied
  
  Fix:
    const handleCameraPermission = async () => {
      const { status, canAskAgain } =
        await Camera.requestCameraPermissionsAsync()
      
      switch (status) {
        case 'granted':
          // Continue normally
          openCamera()
          break
          
        case 'denied':
          if (canAskAgain) {
            // Explain and offer to re-request
            showPermissionRationale()
          } else {
            // Direct to settings
            showGoToSettingsDialog()
          }
          break
          
        case 'undetermined':
          // Don't force, wait for user action
          break
      }
    }

VULN-PERM-004 — Background Location without justification
  Severity: HIGH (CVSS 6.5)
  MASVS    : MASVS-PLATFORM-7
  
  Detection:
    AndroidManifest.xml:
    <uses-permission
      android:name="android.permission.ACCESS_BACKGROUND_LOCATION"/>
    
    Info.plist:
    NSLocationAlwaysAndWhenInUseUsageDescription
    NSLocationAlwaysUsageDescription
  
  Questions to ask:
    → Does the app REALLY need background location?
    → An active delivery app: YES
    → An e-commerce app: NO
    → A fitness tracking app: YES but with explicit consent
  
  Fix:
    → If background location unnecessary: remove
    → If necessary: clear justification in privacy policy
    → Request only when user activates tracking
    → Provide a way to easily disable
    → Visible indicator when location is active
