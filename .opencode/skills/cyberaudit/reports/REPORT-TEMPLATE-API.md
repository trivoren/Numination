# API Security Audit Report

**Target:** [API Name/URL]
**Date:** [YYYY-MM-DD]
**Auditor:** [Name]
**Version:** [API Version]

## Executive Summary

[Brief overview: scope, critical findings, overall risk level]

**Risk Level:** [Critical / High / Medium / Low]
**Endpoints Tested:** [X]
**Vulnerabilities Found:** [X]

## Scope

### In Scope
- [Endpoint 1]
- [Endpoint 2]
- [Authentication mechanism]
- [API version]

### Out of Scope
- [Anything excluded]

## Methodology

- [X] Discovery & Mapping
- [X] Authentication Testing
- [X] Authorization Testing (BOLA/BOPLA)
- [X] Input Validation
- [X] Rate Limiting
- [X] Data Exposure
- [X] Configuration Review

## Findings

### CRITICAL
| # | Finding | Endpoint | Impact | Remediation |
|---|---------|----------|--------|-------------|
| 1 | [Title] | [URL] | [Impact] | [Fix] |
| 2 | [Title] | [URL] | [Impact] | [Fix] |

### HIGH
| # | Finding | Endpoint | Impact | Remediation |
|---|---------|----------|--------|-------------|
| 3 | [Title] | [URL] | [Impact] | [Fix] |

### MEDIUM
| # | Finding | Endpoint | Impact | Remediation |
|---|---------|----------|--------|-------------|
| 4 | [Title] | [URL] | [Impact] | [Fix] |

## Detailed Findings

### Finding 1: [Title] (Critical)
**Endpoint:** [URL]
**Description:** [Detailed description]
**Request:**
```http
GET /api/...
```
**Response:**
```http
HTTP/1.1 200 OK
{ ... }
```
**Impact:** [Business/technical impact]
**Remediation:** [Step-by-step fix]
**CVSS:** [Score]

### Finding 2: [Title]
...

## Recommendations

1. [Priority action]
2. [Priority action]
3. [Priority action]

## Appendix

### Tools Used
- [Tool/version]

### Reference
- OWASP API Security Top 10 (2023)
- [Other references]
