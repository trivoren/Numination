# GraphQL API — Security Audit Guide

## Unique Risks

GraphQL changes the attack model fundamentally:
- Single endpoint, all operations
- Client decides what data to fetch
- Nested queries can cause DoS
- Introspection leaks the entire schema

## Vulnerability Patterns

### CRITICAL — Introspection Enabled
```graphql
query { __schema { types { name fields { name } } } }
```
An attacker gets your entire schema: all types, fields, mutations.
Fix: disable introspection in production.

### CRITICAL — No Depth Limiting
```graphql
query {
  user { posts { comments { user { posts { comments { ... } } } } } }
}
```
Deeply nested queries can crash the server.
Fix: max depth limit (typically 5-7 levels).

### HIGH — No Query Complexity Analysis
Some queries are cheap (single field), some are expensive (list all).
```graphql
query { allUsers { posts { comments } } }
```
Fix: assign cost to each field, reject queries over limit.

### HIGH — Batching Attacks
```graphql
query {
  u1: user(id: 1) { creditCard }
  u2: user(id: 2) { creditCard }
  # ... 500 more
}
```
Single query enumerates many records.
Fix: rate limit by query complexity, not just by request count.

### HIGH — Missing Authorization
GraphQL resolves fields independently. A field might be authorized at the query level but not at the nested resolver level.
```
User.orders → authorized in resolver ✓
User.orders[0].adminNotes → resolver forgets auth check ✗
```
Fix: authorize every resolver independently.

### MEDIUM — Field Suggestions
```
query { uesrs { name } }
# Response: "Did you mean 'users'?"
```
Suggestions leak valid field names.
Fix: disable suggestions in production.

### MEDIUM — Mutations Without Rate Limiting
Mutations modify data. Unchecked mutations allow:
- Mass account creation
- Mass password reset requests
- Rapid data modification

Fix: stricter rate limits on mutations vs queries.

## GraphQL-Specific Best Practices

1. Disable introspection in production
2. Implement query depth limiting
3. Implement query complexity analysis
4. Rate limit by query complexity, not count
5. Authorize every resolver independently
6. Disable field suggestions
7. Use persisted queries where possible
8. Limit batch request size
9. Validate all mutation inputs strictly
10. Monitor for abnormal query patterns
