# 🎯 IDOR / BOLA — VULNERABILITY GUIDE
# Insecure Direct Object Reference / Broken Object Level Authorization

═══════════════════════════════════════════════════════════════
               DEFINITION
═══════════════════════════════════════════════════════════════

IDOR = Access to a resource by manipulating its identifier
       without verifying the user has permission.

BOLA = OWASP API Security term for the same concept on the API side.

It is the most common and most impactful vulnerability
in modern web applications.

OWASP Top 10 : A01:2021
OWASP API    : API1:2023

═══════════════════════════════════════════════════════════════
               DETECTING IDOR
═══════════════════════════════════════════════════════════════

SEARCH EVERYWHERE AN ID IS USED :
  URLs          : /api/users/123, /documents/456
  Body          : { "userId": 123, "orderId": 456 }
  Query params  : ?accountId=789&fileId=101
  Headers       : X-User-Id: 123 (custom headers)

TYPES OF IDOR :
  Sequential numeric IDs   : /order/1042 → /order/1041
  Base64 IDs               : /file/dXNlcjEyMw==
  UUIDs exposed in API     : If listing possible → enumeration
  Predictable file names   : /uploads/invoice_user123_2024.pdf
  File paths               : /download?path=users/123/file.pdf

VULNERABLE CODE TO DETECT :
  // Node.js
  app.get('/api/orders/:id', async (req, res) => {
    const order = await Order.findById(req.params.id)
    // NO check that order.userId === req.user.id !
    res.json(order)
  })

  // PHP/Laravel
  public function show($id) {
    $invoice = Invoice::find($id)
    return $invoice // NO ownership check!
  }

  // Prisma/TypeORM
  async getDocument(id: string) {
    return this.db.document.findUnique({ where: { id } })
    // No where userId!
  }

═══════════════════════════════════════════════════════════════
               IDOR VARIANTS
═══════════════════════════════════════════════════════════════

INDIRECT IDOR (most often missed)
  // A can access B that belongs to C without being C
  GET /api/projects/123/members
  // The user is a member of project 123
  // But do they have the right to see the members?

IDOR VIA RELATIONS
  GET /api/comments/456
  // Comment 456 belongs to a private post
  // But comment access does not check post visibility

IDOR IN BATCH OPERATIONS
  DELETE /api/messages?ids=1,2,3,4,5
  // Is each ID verified individually?

IDOR IN WRITE OPERATIONS (often more severe)
  PUT /api/profiles/123
  // User 456 modifies profile 123

IDOR VIA EXPORT
  GET /api/export?userId=123
  // Exports user 123's data

═══════════════════════════════════════════════════════════════
               REMEDIATION
═══════════════════════════════════════════════════════════════

FUNDAMENTAL PRINCIPLE :
  The user ID ALWAYS comes from the token/session.
  NEVER from the body, params, or query strings.

UNIVERSAL FIX PATTERN :
  // Instead of :
  resource = findById(requestedId)

  // Always :
  resource = findById(requestedId, WHERE ownerId = currentUserId)

NODE.JS — COMPLETE FIX
  // Middleware that extracts user from token
  const getCurrentUser = (req) => {
    // Already done by JWT middleware
    return req.user // Comes from the token, not the body
  }

  // Secured route
  app.get('/api/orders/:orderId', auth, async (req, res) => {
    const currentUser = getCurrentUser(req)

    const order = await Order.findOne({
      where: {
        id:     req.params.orderId,
        userId: currentUser.id,  // Ownership check integrated in query
      }
    })

    if (!order) {
      // 404 rather than 403 : don't confirm the resource exists
      return res.status(404).json({ error: 'Resource not found' })
    }

    res.json(order)
  })

USE UUIDS
  // Instead of sequential IDs :
  id: 1042, 1043, 1044... → trivial to enumerate

  // Use UUIDs v4 :
  id: "f47ac10b-58cc-4372-a567-0e02b2c3d479"
  // Impossible to guess, but ownership check remains mandatory!

IDOR MONITORING
  // Alert on abnormal access patterns
  const accessLog = async (userId, resourceId, success) => {
    await AuditLog.create({
      userId, resourceId, success,
      timestamp: new Date(),
      ip: req.ip,
    })

    // If >10 denied accesses in 1 minute → alert
    const recentFailures = await AuditLog.count({
      where: {
        userId,
        success: false,
        timestamp: { $gt: new Date(Date.now() - 60000) }
      }
    })

    if (recentFailures > 10) {
      await alertSecurityTeam({ userId, type: 'possible_idor_scan' })
    }
  }
