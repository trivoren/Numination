# API Inventory — Asset Management

## Why It Matters

APIs proliferate faster than documentation:
- Shadow APIs (undeclared, unmonitored)
- Deprecated versions (still running, weaker security)
- Debug endpoints (exposed in production)
- Misconfigured new endpoints

## Discovery Techniques

### Automated
```bash
# Subdomain enumeration
subfinder -d example.com | httpx -silent

# Path enumeration
ffuf -w /usr/share/wordlists/api.txt -u https://api.example.com/FUZZ

# Swagger/OpenAPI discovery
ffuf -w endpoints.txt -u https://example.com/FUZZ/swagger.json
```

### Manual
- Review JavaScript source for API calls
- Check network tab in browser devtools
- Monitor DNS records for subdomain patterns
- Review job postings for tech stack hints

### From Response Analysis
- Look for API version headers
- Check response structure differences
- Identify internal hostnames or IPs

## Inventory Checklist

- [ ] All API subdomains mapped
- [ ] All API paths discovered
- [ ] HTTP methods tested per path
- [ ] Content types tested per endpoint
- [ ] Authentication status per endpoint
- [ ] Version history documented
- [ ] Deprecated endpoints flagged
- [ ] Debug/test endpoints identified
- [ ] Third-party API dependencies listed
- [ ] Shadow APIs found and documented
