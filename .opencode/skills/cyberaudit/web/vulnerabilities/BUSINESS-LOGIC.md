# 🧠 BUSINESS LOGIC — CYBERAUDIT SKILL
# Business logic vulnerabilities — The hardest to detect

═══════════════════════════════════════════════════════════════
  NATURE OF THESE VULNERABILITIES :
  
  Business logic flaws are not detectable
  by automated scanners.
  They require understanding WHAT THE APP IS SUPPOSED TO DO
  to identify WHAT THE APP ACTUALLY DOES.
  
  A scanner sees code. An expert sees intent.
  These flaws require being the expert.
═══════════════════════════════════════════════════════════════

═══════════════════════════════════════════════════════════════
               BUSINESS LOGIC FLAW CATEGORIES
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CATEGORY 1 — PRICE AND VALUE MANIPULATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRINCIPLE :
  Price, quantity, amount must NEVER
  come from the client. Always recalculated server-side.

CRITICAL PATTERN 1 — Price sent by client
  DETECT :
    // Frontend sends the price
    POST /api/checkout
    {
      "product_id": 42,
      "quantity": 1,
      "price": 9.99    ← Price provided by client!
    }
    
    // And the backend uses it directly
    public function checkout(Request $request) {
        $order = Order::create([
            'product_id' => $request->product_id,
            'quantity'   => $request->quantity,
            'price'      => $request->price,     // ← VULNERABLE
            'total'      => $request->price * $request->quantity
        ]);
        $this->processPayment($order->total);
    }
  
  EXPLOITATION SCENARIO :
    Attacker modifies request with Burp Suite :
    "price": 0.01  → Buys a 999€ product for 0.01€
    "price": -1    → Receives a refund on purchase
    "quantity": -1 → Possible inverted logic

  FIX :
    public function checkout(Request $request) {
        // Never trust the client's price
        // ALWAYS recalculate server-side
        $product = Product::findOrFail($request->product_id);
        
        // Verify product is available
        if (!$product->is_available) {
            return response()->json(['error' => 'Product unavailable'], 400);
        }
        
        // Validate quantity
        $quantity = (int) $request->quantity;
        if ($quantity < 1 || $quantity > 100) {
            return response()->json(['error' => 'Invalid quantity'], 400);
        }
        
        // Calculate price SERVER-SIDE only
        $unitPrice = $product->current_price; // Price from DB
        $discount  = $this->calculateDiscount($product, auth()->user());
        $total     = ($unitPrice * $quantity) * (1 - $discount);
        
        $order = Order::create([
            'user_id'    => auth()->id(),
            'product_id' => $product->id,
            'quantity'   => $quantity,
            'unit_price' => $unitPrice,  // Server price
            'discount'   => $discount,
            'total'      => $total,      // Server-calculated
        ]);
        
        $this->processPayment($order->total); // Server amount
    }

CRITICAL PATTERN 2 — Negative values not validated
  DETECT :
    // Money transfer without sign validation
    public function transfer(Request $request) {
        $amount = $request->amount; // Can be negative!
        
        auth()->user()->balance -= $amount;
        $recipient->balance += $amount;
        // If amount = -100 : the sender GAINS 100!
    }
    
    // Coupon application without validation
    $discount = $coupon->discount_percentage / 100;
    $total = $price - ($price * $discount);
    // If discount = 150% : negative total → refund?
  
  FIX :
    public function transfer(Request $request) {
        $request->validate([
            'amount' => 'required|numeric|min:0.01|max:10000',
            // min:0.01 prevents negative values and zero
        ]);
        
        $amount = round((float)$request->amount, 2);
        
        // Check balance before transaction
        if (auth()->user()->balance < $amount) {
            return response()->json(['error' => 'Insufficient balance'], 400);
        }
        
        DB::transaction(function() use ($amount, $recipient) {
            auth()->user()->decrement('balance', $amount);
            $recipient->increment('balance', $amount);
            
            // Transaction log for audit
            Transaction::create([
                'from_user_id' => auth()->id(),
                'to_user_id'   => $recipient->id,
                'amount'       => $amount,
                'ip_address'   => request()->ip(),
            ]);
        });
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CATEGORY 2 — RACE CONDITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRINCIPLE :
  Two simultaneous requests can both pass
  the same check "before" the state changes.
  Result : double spend, double action, double allocation.

CRITICAL PATTERN 3 — Double spend / Double action
  DETECT :
    // Code that checks THEN modifies without atomicity
    public function usePromoCode(Request $request) {
        $code = PromoCode::where('code', $request->code)
                         ->where('used', false) // ← Check
                         ->first();
        
        if (!$code) {
            return response()->json(['error' => 'Invalid code'], 400);
        }
        
        // ← RACE CONDITION HERE
        // Two simultaneous requests pass the check
        // before either one sets used = true
        
        $code->update(['used' => true]);
        $this->applyDiscount(auth()->user());
    }
  
  EXPLOITATION SCENARIO :
    Attacker sends 10 simultaneous requests.
    All see used = false.
    All apply the discount.
    Code used 10 times instead of once.

  FIX :
    public function usePromoCode(Request $request) {
        // Option A : Atomic update with where
        $updated = PromoCode::where('code', $request->code)
                             ->where('used', false)
                             ->update([
                                 'used'    => true,
                                 'used_by' => auth()->id(),
                                 'used_at' => now(),
                             ]);
        
        // If no rows updated → code already used
        if ($updated === 0) {
            return response()->json(['error' => 'Invalid or already used code'], 400);
        }
        
        // Option B : DB Lock (for more complex cases)
        DB::transaction(function() use ($request) {
            $code = PromoCode::where('code', $request->code)
                             ->lockForUpdate() // SELECT ... FOR UPDATE
                             ->first();
            
            if (!$code || $code->used) {
                throw new \Exception('Invalid code');
            }
            
            $code->update(['used' => true, 'used_by' => auth()->id()]);
            $this->applyDiscount(auth()->user());
        });
        
        // Option C : Redis for distributed operations
        $key = "promo_code_lock:{$request->code}";
        if (!Cache::add($key, true, 30)) { // NX = only if absent
            return response()->json(['error' => 'Code already being used'], 429);
        }
        // Normal processing...
    }

HIGH PATTERN 4 — Race condition on balance/stock
  DETECT :
    // Stock check without atomicity
    if ($product->stock > 0) {
        // ← Race condition possible
        $product->decrement('stock');
        // Stock can go negative with simultaneous requests
    }
  
  FIX :
    // Atomic decrement with verification
    $updated = Product::where('id', $product->id)
                       ->where('stock', '>', 0)
                       ->decrement('stock');
    
    if ($updated === 0) {
        return response()->json(['error' => 'Out of stock'], 400);
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CATEGORY 3 — WORKFLOW BYPASS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRINCIPLE :
  Process steps (order, verification,
  approval) must be in order and verified.
  Do not assume the previous step was done.

HIGH PATTERN 5 — Skipped workflow step
  DETECT :
    // Checkout without verifying cart is valid
    public function confirmOrder(Request $request) {
        $order = Order::findOrFail($request->order_id);
        // No verification that payment was made!
        // No verification of order status!
        $order->update(['status' => 'confirmed']);
        $this->shipOrder($order);
    }
    
    // Publication without validation
    public function publishArticle(Request $request) {
        $article = Article::findOrFail($request->id);
        // No verification article is in "draft" status
        // Can a "rejected" article be republished directly?
        $article->update(['status' => 'published']);
    }
  
  FIX :
    public function confirmOrder(Request $request) {
        $order = Order::where('id', $request->order_id)
                       ->where('user_id', auth()->id())
                       ->firstOrFail();
        
        // Explicit state machine
        $allowedTransitions = [
            'pending'    => ['paid', 'cancelled'],
            'paid'       => ['confirmed', 'refunded'],
            'confirmed'  => ['shipped', 'cancelled'],
            'shipped'    => ['delivered'],
        ];
        
        $targetStatus = 'confirmed';
        $allowedNextStates = $allowedTransitions[$order->status] ?? [];
        
        if (!in_array($targetStatus, $allowedNextStates)) {
            return response()->json([
                'error' => "Invalid transition: {$order->status} → {$targetStatus}"
            ], 422);
        }
        
        // Check specific prerequisites
        if ($targetStatus === 'confirmed' && !$order->payment_verified) {
            return response()->json(['error' => 'Payment not verified'], 400);
        }
        
        $order->update(['status' => $targetStatus]);
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CATEGORY 4 — FEATURE ABUSE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRINCIPLE :
  A legitimate feature can be abused
  in a way not anticipated by the developer.

HIGH PATTERN 6 — Circular reference / self-reference
  DETECT :
    // Transfer to self
    public function transfer(Request $request) {
        // No check that from ≠ to
        $sender    = auth()->user();
        $recipient = User::findOrFail($request->to_user_id);
        
        // If sender = recipient : unexpected behavior?
        // If calculation error : money created?
    }
    
    // Self-referral
    public function applyReferral(Request $request) {
        // No check that referrer ≠ referred
        $referrer = User::where('code', $request->code)->first();
        $this->applyBonus($referrer, auth()->user());
    }
  
  FIX :
    public function transfer(Request $request) {
        $request->validate([
            'to_user_id' => 'required|integer|different:' . auth()->id(),
            // different: prevents self-transfer
        ]);
    }
    
    public function applyReferral(Request $request) {
        $referrer = User::where('referral_code', $request->code)
                        ->where('id', '!=', auth()->id()) // Not self
                        ->first();
        
        if (!$referrer) {
            return response()->json(['error' => 'Invalid referral code'], 400);
        }
        
        // Check they haven't already used a code
        if (auth()->user()->referred_by !== null) {
            return response()->json(['error' => 'Code already used'], 400);
        }
    }

MEDIUM PATTERN 7 — Pagination/export abuse
  DETECT :
    // Export without limit
    public function exportUsers(Request $request) {
        // No limit → export of the ENTIRE database
        return User::all()->toArray(); // Millions of records?
        
        // Or pagination without limit
        $limit = $request->limit ?? 100;
        // Attacker sends limit=1000000
        return User::paginate($limit);
    }
  
  FIX :
    public function exportUsers(Request $request) {
        $request->validate([
            'limit' => 'integer|max:1000', // Server-imposed maximum
        ]);
        
        // Export by chunks with absolute limit
        $maxExport = 10000;
        $limit = min($request->limit ?? 100, $maxExport);
        
        // Log the export (traceability)
        AuditLog::create([
            'action'  => 'data_export',
            'user_id' => auth()->id(),
            'count'   => $limit,
            'ip'      => request()->ip(),
        ]);
        
        return User::select(['id', 'name', 'email']) // Minimal fields
                   ->paginate($limit);
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CATEGORY 5 — TOCTOU (TIME OF CHECK / TIME OF USE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PRINCIPLE :
  The state verified at check time may have changed
  by the time of use.
  Check and use must be atomic.

HIGH PATTERN 8 — TOCTOU on eligibility
  DETECT :
    // Eligibility check followed by non-atomic action
    public function claimReward(Request $request) {
        $user = auth()->user();
        
        // CHECK : Is the user eligible?
        if ($user->points >= 1000 && !$user->reward_claimed) {
            
            // ← TOCTOU HERE
            // Between check and update,
            // another request can modify state
            
            sleep(1); // Simulate processing
            
            // USE : Assign reward
            $user->update([
                'reward_claimed' => true,
                'points'         => $user->points - 1000
            ]);
            
            $this->sendReward($user);
        }
    }
  
  FIX :
    public function claimReward(Request $request) {
        // Atomic check and update
        $updated = User::where('id', auth()->id())
                       ->where('points', '>=', 1000)
                       ->where('reward_claimed', false)
                       ->update([
                           'reward_claimed' => true,
                           'points'         => DB::raw('points - 1000'),
                           'reward_date'    => now(),
                       ]);
        
        if ($updated === 0) {
            return response()->json([
                'error' => 'Not eligible or reward already claimed'
            ], 400);
        }
        
        $this->sendReward(auth()->user()->fresh());
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CATEGORY 6 — UNVERIFIED LIMITS AND BOUNDARIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MEDIUM PATTERN 9 — Business limits not enforced server-side
  DETECT :
    // Account limit per email not checked server-side
    public function register(Request $request) {
        // The "1 account per person" limit is only checked
        // client-side → trivial bypass
        User::create([...]);
    }
    
    // Offer usage limit
    public function claimOffer(Request $request) {
        // "One offer per user" only verified
        // by a UI constraint
        Offer::create(['user_id' => auth()->id()]);
    }
  
  FIX :
    public function register(Request $request) {
        // Server-side limit : 1 active account per email
        $existingCount = User::where('email', $request->email)
                             ->where('status', 'active')
                             ->count();
        
        if ($existingCount >= 1) {
            return response()->json([
                'error' => 'An account already exists with this email'
            ], 422);
        }
        
        // IP-based limit (anti-mass creation)
        $recentRegistrations = User::where('registration_ip', $request->ip())
                                   ->where('created_at', '>', now()->subHour())
                                   ->count();
        
        if ($recentRegistrations >= 3) {
            return response()->json([
                'error' => 'Too many accounts created from this address'
            ], 429);
        }
        
        User::create([..., 'registration_ip' => $request->ip()]);
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CATEGORY 7 — STATE AND PARAMETER MANIPULATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 10 — Injectable context parameter
  DETECT :
    // Multi-tenant : tenant_id provided by client
    public function getData(Request $request) {
        $tenantId = $request->tenant_id; // ← Client controls!
        
        $data = Data::where('tenant_id', $tenantId)->get();
        // A user can access another tenant's data!
    }
    
    // Currency/locale manipulation
    public function getPrice(Request $request) {
        $currency = $request->currency ?? 'EUR';
        $price = Product::find($id)->price;
        return $this->convert($price, 'EUR', $currency);
        // If conversion is poorly implemented → absurd prices
    }
  
  FIX :
    public function getData(Request $request) {
        // Always get tenant from session/token
        // NEVER from the client request
        $tenantId = auth()->user()->tenant_id; // From identity
        
        $data = Data::where('tenant_id', $tenantId)->get();
    }
    
    public function getPrice(Request $request) {
        // Validate currency against a whitelist
        $allowedCurrencies = ['EUR', 'USD', 'GBP', 'JPY'];
        $currency = in_array($request->currency, $allowedCurrencies)
            ? $request->currency
            : 'EUR'; // Secure default
        
        $price = Product::findOrFail($id)->price;
        return $this->convert($price, 'EUR', $currency);
    }

═══════════════════════════════════════════════════════════════
               DETECTION METHODOLOGY FOR THE AGENT
═══════════════════════════════════════════════════════════════

QUESTIONS TO ASK FOR EACH BUSINESS FEATURE
────────────────────────────────────────

  □ Do monetary values/quantities come from the client?
    → Always recalculate server-side

  □ Is there a "check then act" without atomicity?
    → Race condition risk → atomize with DB transaction

  □ Are workflow steps verified sequentially?
    → Implement an explicit state machine

  □ Can a feature be used on oneself?
    → Check self-references

  □ Are business limits enforced server-side?
    → All business rules must be server-side

  □ Does a context parameter (tenant, currency, role) come
    from the client?
    → Always extract from token/session, never from body

  □ What happens with extreme values?
    (0, -1, MAX_INT, empty string, very long string)
    → Test edge cases

  □ What happens if the action is repeated N times?
    → Idempotence and uniqueness

  □ What happens if steps are done out of order?
    → Workflow enforcement

  □ Who benefits financially or functionally
    from exploiting this flaw?
    → Identify attacker motivation

═══════════════════════════════════════════════════════════════
               BUSINESS LOGIC CHECKLIST
═══════════════════════════════════════════════════════════════

VALUES AND CALCULATIONS
  □ Prices/amounts calculated server-side only?
  □ Negative values rejected on quantities/amounts?
  □ Zero values handled correctly?
  □ Numeric overflow/underflow handled?
  □ Consistent monetary rounding (no naive floating point)?

CONCURRENCY
  □ Critical operations atomic (DB transactions)?
  □ Locks used on shared resources?
  □ Idempotence on replayable operations?
  □ Double-submit prevention (forms, buttons)?

WORKFLOW
  □ Explicit state machine for multi-step processes?
  □ State transitions validated server-side?
  □ Prerequisites for each step verified before execution?
  □ Rollback on partial failure?

BUSINESS LIMITS
  □ All "1 per user", "max N" rules server-side?
  □ Self-references prohibited (self-transfer, self-referral)?
  □ Context parameters (tenant, role) from session?
  □ Export/pagination limits enforced server-side?

EDGE CASES
  □ Behavior with banned/suspended user verified?
  □ Behavior at end of offer period verified?
  □ Behavior with zero stock verified?
  □ Behavior at boundary timezones?

═══════════════════════════════════════════════════════════════
               REFERENCES
═══════════════════════════════════════════════════════════════

  OWASP Testing Guide — Business Logic Testing :
  https://owasp.org/www-project-web-security-testing-guide/
  latest/4-Web_Application_Security_Testing/10-Business_Logic_Testing/

  CWE-840 — Business Logic Errors :
  https://cwe.mitre.org/data/definitions/840.html

  OWASP A04:2021 — Insecure Design :
  https://owasp.org/Top10/A04_2021-Insecure_Design/

  PortSwigger Business Logic Vulnerabilities :
  https://portswigger.net/web-security/logic-flaws
