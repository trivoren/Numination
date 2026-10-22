# 💉 INJECTION — VULNERABILITY GUIDE
# All forms of injection for web applications

═══════════════════════════════════════════════════════════════
               DEFINITION
═══════════════════════════════════════════════════════════════

AN INJECTION = untrusted data sent to an interpreter
The interpreter cannot distinguish between
data and commands → it executes data as commands.

OWASP : A03:2021 — Injection
CWE   : CWE-89 (SQL), CWE-77 (Command), CWE-94 (Code)

═══════════════════════════════════════════════════════════════
               SQL INJECTION
═══════════════════════════════════════════════════════════════

TYPES :
  Classic    : Result directly visible
  Blind      : No result → behavior analysis
  Time-based : Based on response delays (SLEEP())
  Second-order: Injected now, executed later

PATTERNS TO DETECT (all frameworks) :
  Direct interpolation : "SELECT * FROM users WHERE id = " + id
  Template literals     : `SELECT * FROM users WHERE id = ${id}`
  PHP concatenation     : "WHERE name = '" . $name . "'"
  Format string         : sprintf("WHERE id = %s", $id)

DETECTING DANGEROUS FUNCTIONS :
  PHP    : mysqli_query(), pg_query(), sqlite_query() with variables
  Node   : db.query(), pool.execute() without parameters
  Python : cursor.execute() with f-string or %

UNIVERSAL REMEDIATION :
  1. Parameterized queries (prepared statements)
  2. ORM with safe query methods
  3. Whitelist for non-parameterizable parts (ORDER BY, table names)
  4. Principle of least privilege on DB account

═══════════════════════════════════════════════════════════════
               NOSQL INJECTION
═══════════════════════════════════════════════════════════════

MONGODB — DANGEROUS PATTERNS :
  DETECT :
    // User input passed directly as filter
    db.users.find({ username: req.body.username })
    // If username = { $gt: "" } → returns all users!

    // $where with JS code
    db.users.find({ $where: `this.username == '${username}'` })

    // Unrestricted regex → ReDoS
    db.products.find({ name: { $regex: req.query.search } })

  FIX :
    // Sanitize MongoDB operators
    import mongoSanitize from 'express-mongo-sanitize'
    app.use(mongoSanitize())

    // Or strict type validation
    const username = String(req.body.username)
    // String() converts everything to string,
    // { $gt: "" } becomes "[object Object]"

    // For Mongoose, use typed methods
    await User.findOne({ username: username })  // Mongoose escapes

    // $where : never use with user input
    // Regex : always limit complexity
    const searchTerm = req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await Product.find({ name: { $regex: searchTerm, $options: 'i' } })

═══════════════════════════════════════════════════════════════
               COMMAND INJECTION
═══════════════════════════════════════════════════════════════

DANGEROUS PATTERNS :
  NODE.JS :
    exec(`ping ${host}`)
    execSync(`convert ${req.file.path} output.jpg`)
    spawn('sh', ['-c', userCommand])

  PHP :
    system("ping " . $host);
    exec("ffmpeg -i " . $filename);
    shell_exec(`convert {$userInput}`);

  REMEDIATION :
    // Avoid shell commands with user input
    // Use native libraries instead

    // ❌ Instead of:
    exec(`convert ${inputFile} ${outputFile}`)

    // ✅ Use sharp (Node.js) :
    import sharp from 'sharp'
    await sharp(inputPath).resize(800).toFile(outputPath)

    // If shell unavoidable : strict validation + no shell=true
    import { execFile } from 'child_process'

    // Whitelist commands and arguments
    const allowedHosts = ['google.com', 'github.com']
    if (!allowedHosts.includes(host)) throw new Error('Host not allowed')

    execFile('ping', ['-c', '1', host], (err, stdout) => {
      // execFile does not interpret shell
      // Arguments are passed directly, not via sh -c
    })

═══════════════════════════════════════════════════════════════
               SSTI (SERVER-SIDE TEMPLATE INJECTION)
═══════════════════════════════════════════════════════════════

VULNERABLE ENGINES AND TEST PAYLOADS :
  Jinja2/Twig : {{7*7}} → 49 if vulnerable
  Twig        : {{_self.env.registerUndefinedFilterCallback("exec")}}
  EJS         : <%= 7*7 %>
  Handlebars  : {{constructor.constructor('return process')()}}
  Pug/Jade    : #{7*7}

PATTERNS TO DETECT :
  // Template compiled with user input
  const template = ejs.compile(req.body.template)
  const html = pug.render(userTemplate)
  const result = nunjucks.renderString(userContent, data)

REMEDIATION :
  // Never render templates provided by the user
  // Use static templates with variables
  // (not dynamic templates provided by the user)

  // ❌ DANGEROUS :
  const rendered = ejs.render(req.body.emailTemplate, { name: user.name })

  // ✅ SECURE : Fixed template, variable data
  const rendered = ejs.render(
    fs.readFileSync('./templates/email.ejs', 'utf-8'),
    { name: sanitize(user.name) }
  )

═══════════════════════════════════════════════════════════════
               LDAP INJECTION
═══════════════════════════════════════════════════════════════

DANGEROUS PATTERNS :
  filter = "(&(uid=" + username + ")(userPassword=" + password + "))"
  // If username = *)(&  → auth bypass possible

REMEDIATION :
  // Escape LDAP special characters
  function escapeLdap(input: string): string {
    return input
      .replace(/\\/g, '\\5c')
      .replace(/\*/g, '\\2a')
      .replace(/\(/g, '\\28')
      .replace(/\)/g, '\\29')
      .replace(/\0/g, '\\00')
  }

  const safeUsername = escapeLdap(username)
  const filter = `(&(uid=${safeUsername})(objectClass=person))`
