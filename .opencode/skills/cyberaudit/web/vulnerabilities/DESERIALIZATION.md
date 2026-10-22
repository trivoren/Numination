# 💣 DESERIALIZATION — VULNERABILITY GUIDE

═══════════════════════════════════════════════════════════════
               DEFINITION
═══════════════════════════════════════════════════════════════

INSECURE DESERIALIZATION =
  Deserializing untrusted data can lead to :
  → Remote Code Execution (RCE) via gadget chains
  → Object injection with malicious behavior
  → DoS via malformed objects

OWASP : A08:2021 — Software and Data Integrity Failures
CWE   : CWE-502

MOST AT-RISK LANGUAGES :
  → PHP (unserialize)
  → Java (ObjectInputStream)
  → Python (pickle)
  → Ruby (Marshal)
  → Node.js (rare but possible)

═══════════════════════════════════════════════════════════════
               PATTERNS TO DETECT
═══════════════════════════════════════════════════════════════

PHP — CRITICAL :
  unserialize($userInput)
  unserialize(base64_decode($cookie))
  unserialize(base64_decode($_COOKIE['cart']))
  unserialize(file_get_contents($userProvidedPath))

  // Second-order : data deserialized from DB
  // that was inserted via user input

PYTHON — CRITICAL :
  pickle.loads(userInput)
  pickle.load(file_from_user)
  yaml.load(userInput)  // PyYAML without Loader=yaml.SafeLoader

NODE.JS — LESS COMMON BUT PRESENT :
  // node-serialize
  serialize.unserialize(userInput)
  // eval() in custom parsers

═══════════════════════════════════════════════════════════════
               REMEDIATION
═══════════════════════════════════════════════════════════════

PHP :
  // ❌ Never deserialize user data
  unserialize($userInput) // Never

  // ✅ Use JSON
  $data = json_decode($userInput, true)

  // ✅ If serialize() needed for internal cache :
  //    Ensure data never comes from the user
  //    Sign serialized data with HMAC
  $serialized = serialize($data)
  $hmac = hash_hmac('sha256', $serialized, $secret)
  $stored = $hmac . ':' . $serialized

  // On read :
  [$storedHmac, $storedData] = explode(':', $stored, 2)
  if (!hash_equals($storedHmac, hash_hmac('sha256', $storedData, $secret))) {
    throw new Exception('Corrupted data')
  }
  $data = unserialize($storedData)

PYTHON :
  # ❌ Never pickle with user input
  data = pickle.loads(userInput)  # RCE possible

  # ✅ JSON
  data = json.loads(userInput)

  # ✅ Secure PyYAML
  data = yaml.load(userInput, Loader=yaml.SafeLoader)
  # yaml.SafeLoader does not execute Python code

  # If pickle needed for internal cache :
  # Sign with hmac before storage
  import hmac, hashlib, pickle

  def safe_serialize(data, secret):
      pickled = pickle.dumps(data)
      sig = hmac.new(secret, pickled, hashlib.sha256).digest()
      return sig + pickled

  def safe_deserialize(data, secret):
      sig, pickled = data[:32], data[32:]
      expected = hmac.new(secret, pickled, hashlib.sha256).digest()
      if not hmac.compare_digest(sig, expected):
          raise ValueError('Invalid signature')
      return pickle.loads(pickled)
