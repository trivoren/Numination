# 🐘 LARAVEL — SECURITY AUDIT GUIDE
# Comprehensive audit guide for Laravel applications

═══════════════════════════════════════════════════════════════
               COMPLETE LARAVEL THREAT MODEL
═══════════════════════════════════════════════════════════════

LARAVEL ATTACK SURFACE
──────────────────────────

  LAYER 1 — ROUTES & MIDDLEWARE
    Risks: Routes without auth, bypassed middleware,
              rate limiting absent, CSRF disabled

  LAYER 2 — CONTROLLERS & REQUESTS
    Risks: Insufficient validation, mass assignment,
              injection via request()->all()

  LAYER 3 — ELOQUENT & DATABASE  
    Risks: Raw queries, whereRaw injection,
              N+1 not critical but revealing

  LAYER 4 — BLADE TEMPLATES
    Risks: {!! !!} unsanitized, XSS via output

  LAYER 5 — FILE SYSTEM
    Risks: Upload path traversal, public storage
              of sensitive files, MIME bypass

  LAYER 6 — AUTHENTICATION
    Risks: Auth bypass, mass assignment on User,
              poorly implemented remember_me

  LAYER 7 — CONFIGURATION
    Risks: APP_DEBUG=true in prod, exposed .env,
              weak encryption keys

  LAYER 8 — DESERIALIZATION
    Risks: unserialize() with user input,
              Laravel gadget chains

═══════════════════════════════════════════════════════════════
               VULNERABLE LARAVEL PATTERNS
═══════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SQL INJECTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 1 — DB::select with interpolation
  DETECT:
    DB::select("SELECT * FROM users WHERE id = $id")
    DB::select("SELECT * FROM users WHERE email = '{$email}'")
    DB::statement("DELETE FROM logs WHERE date < $date")
  
  FIX:
    DB::select("SELECT * FROM users WHERE id = ?", [$id])
    DB::select("SELECT * FROM users WHERE email = ?", [$email])
    // OR better with Eloquent
    User::where('id', $id)->first()
    User::where('email', $email)->first()

CRITICAL PATTERN 2 — whereRaw with direct variable
  DETECT:
    Model::whereRaw("name = '$name'")->get()
    Model::whereRaw("status = " . $status)->get()
    Model::whereRaw($request->filter)->get()
  
  FIX:
    Model::whereRaw("name = ?", [$name])->get()
    Model::whereRaw("status = ?", [$status])->get()
    // Validate allowed filters first
    $allowedFilters = ['active', 'inactive', 'pending'];
    if (!in_array($request->filter, $allowedFilters)) {
        abort(400);
    }

CRITICAL PATTERN 3 — orderByRaw with user input
  DETECT:
    Model::orderByRaw($request->sort)->get()
    Model::orderByRaw($request->column . ' ' . $request->direction)
  
  FIX:
    $allowedColumns = ['name', 'email', 'created_at', 'updated_at'];
    $allowedDirections = ['asc', 'desc'];
    
    $column = in_array($request->sort, $allowedColumns)
        ? $request->sort : 'created_at';
    $direction = in_array($request->direction, $allowedDirections)
        ? $request->direction : 'desc';
    
    Model::orderBy($column, $direction)->get()

HIGH PATTERN 4 — havingRaw and groupByRaw
  DETECT:
    ->havingRaw($request->having)
    ->groupByRaw($request->group)
  
  FIX:
    // Whitelist of allowed expressions
    $allowedHaving = ['COUNT(*) > 5', 'SUM(amount) > 1000'];
    // Never pass user input directly

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MASS ASSIGNMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 5 — create() with request()->all()
  DETECT:
    User::create($request->all())
    Post::create($request->input())
    $model->fill($request->all())
    $model->update($request->all())
  
  FIX:
    // Option A: strict $fillable
    // In the Model:
    protected $fillable = ['name', 'email', 'bio'];
    // NEVER: protected $guarded = []; // everything allowed
    
    // Option B: validated() with FormRequest
    User::create($request->validated())
    
    // Option C: manual selection
    User::create([
        'name'  => $request->name,
        'email' => $request->email,
    ])
    
    // VERIFY these fields are NOT in $fillable:
    // role, is_admin, is_verified, email_verified_at,
    // balance, credits, stripe_id

CRITICAL PATTERN 6 — update() without whitelist
  DETECT:
    $user->update($request->all())
    $user->update($data) // if $data comes from input
  
  FIX:
    $user->update($request->only(['name', 'bio', 'avatar']))
    // OR
    $user->update($request->validated())

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BLADE XSS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

HIGH PATTERN 7 — Unescaped output
  DETECT:
    {!! $userContent !!}
    {!! $comment->body !!}
    {!! $user->bio !!}
    <?php echo $input; ?>
  
  FIX:
    // For plain text: always {{ }}
    {{ $userContent }}
    
    // For trusted HTML (admin only):
    // Use HTMLPurifier or Sterilize
    {!! clean($userContent) !!}
    
    // Install: composer require mews/purifier
    // Config: config/purifier.php

MEDIUM PATTERN 8 — href with unvalidated variable
  DETECT:
    <a href="{{ $user->website }}">
    <a href="{!! $url !!}">
    <script src="{{ $cdnUrl }}">
  
  FIX:
    // Validate it is indeed an HTTP/HTTPS URL
    @php
        $safeUrl = filter_var($user->website, FILTER_VALIDATE_URL)
            && in_array(parse_url($user->website, PHP_URL_SCHEME), ['http', 'https'])
            ? $user->website : '#';
    @endphp
    <a href="{{ $safeUrl }}">

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IDOR AND AUTHORIZATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 9 — Access without ownership check
  DETECT:
    public function show($id) {
        $order = Order::find($id); // No ownership check!
        return $order;
    }
    
    public function update($id, Request $request) {
        $post = Post::findOrFail($id); // Vulnerable
        $post->update($request->validated());
    }
  
  FIX:
    // Option A: where() with user_id
    public function show($id) {
        $order = Order::where('id', $id)
            ->where('user_id', auth()->id())
            ->firstOrFail();
        return $order;
    }
    
    // Option B: Route Model Binding with Policy
    public function update(Post $post, UpdatePostRequest $request) {
        $this->authorize('update', $post); // Laravel Policy
        $post->update($request->validated());
    }
    
    // Option C: Policy in the controller
    public function destroy(Order $order) {
        if ($order->user_id !== auth()->id()) {
            abort(403, 'Unauthorized action.');
        }
        $order->delete();
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FILE UPLOAD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 10 — Upload without MIME validation
  DETECT:
    $file = $request->file('avatar');
    $file->store('uploads'); // No validation!
    
    $extension = $request->file('doc')->getClientOriginalExtension();
    // getClientOriginalExtension() is spoofable!
  
  FIX:
    use Illuminate\Support\Facades\Storage;
    
    public function uploadAvatar(Request $request) {
        $request->validate([
            'avatar' => [
                'required',
                'file',
                'max:2048', // 2MB max
                'mimes:jpeg,png,gif,webp', // Extension whitelist
                // Real MIME verification (not just extension)
                function ($attribute, $value, $fail) {
                    $mimeType = $value->getMimeType();
                    $allowedMimes = ['image/jpeg', 'image/png', 
                                     'image/gif', 'image/webp'];
                    if (!in_array($mimeType, $allowedMimes)) {
                        $fail('File type not allowed.');
                    }
                },
            ],
        ]);
        
        // Generate a random name (never use the original name)
        $filename = Str::random(40) . '.' . 
                    $request->file('avatar')->extension();
        
        // Store OUTSIDE the public folder if possible
        $path = $request->file('avatar')
            ->storeAs('avatars', $filename, 'private');
        
        // Serve via a controlled route
        // GET /avatar/{filename} → check rights → return the file
    }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL CONFIGURATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 11 — APP_DEBUG in production
  DETECT in .env or config/app.php:
    APP_DEBUG=true
    'debug' => true
    'debug' => env('APP_DEBUG', true) // dangerous default
  
  FIX:
    // .env production
    APP_DEBUG=false
    
    // config/app.php
    'debug' => (bool) env('APP_DEBUG', false),
    
    // Startup verification possible:
    // AppServiceProvider::boot()
    if (app()->isProduction() && config('app.debug')) {
        throw new \RuntimeException(
            'DEBUG MODE IS ENABLED IN PRODUCTION!'
        );
    }

CRITICAL PATTERN 12 — Weak or default application key
  DETECT in .env:
    APP_KEY= (empty)
    APP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
    APP_KEY=SomeEasyToGuessString
  
  FIX:
    // Generate a real key
    php artisan key:generate
    
    // Verify length (must be 32 bytes in base64)
    // Generated key starts with: base64:
    // and is exactly 44 characters after the prefix

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DESERIALIZATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CRITICAL PATTERN 13 — unserialize() with user input
  DETECT:
    unserialize($request->input('data'))
    unserialize(base64_decode($token))
    unserialize(Cookie::get('cart'))
  
  FIX:
    // NEVER unserialize() user data
    // Use JSON instead
    $data = json_decode($request->input('data'), true);
    
    // For sensitive cookies: Laravel encryption
    // (enabled by default via EncryptCookies middleware)
    
    // If serialize() is necessary for internal cache:
    // Ensure the data NEVER comes from the user

═══════════════════════════════════════════════════════════════
               COMPLETE LARAVEL CHECKLIST
═══════════════════════════════════════════════════════════════

ROUTES & MIDDLEWARE
  □ All sensitive routes protected by auth middleware?
  □ CSRF token present on all POST forms?
  □ CSRF disabled only on webhooks with signature validation?
  □ Rate limiting configured on login/register/reset-password?
  □ API throttle configured?
  □ Laravel debug routes disabled in prod?

ELOQUENT MODELS
  □ $fillable defined on ALL models?
  □ $guarded = [] absent?
  □ Sensitive fields in $hidden? (password, remember_token)
  □ Sensitive fields in $casts? (password → hashed)
  □ N+1 relations not exploitable for IDOR?

CONTROLLERS
  □ FormRequest used for validation?
  □ authorize() called in FormRequests?
  □ Ownership verified before every object access?
  □ Response does not return unnecessary sensitive data?

AUTHENTICATION
  □ Password hashing: Hash::make() used?
  □ Comparison: Hash::check() used?
  □ Remember me: limited duration?
  □ Sessions invalidated on logout?
  □ Email verification enabled?
  □ Sanctum/Passport configured correctly?

CONFIGURATION
  □ APP_DEBUG=false in production?
  □ APP_ENV=production in production?
  □ APP_KEY randomly generated?
  □ .env in .gitignore?
  □ config:cache used in prod?
  □ Logs do not contain sensitive data?
  □ Exceptions handler does not reveal infrastructure?

DEPENDENCIES
  □ composer audit executed?
  □ Packages up to date?
  □ composer.lock committed?
