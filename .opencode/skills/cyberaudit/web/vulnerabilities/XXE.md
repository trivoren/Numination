# 📄 XXE — XML EXTERNAL ENTITIES GUIDE

═══════════════════════════════════════════════════════════════
               DEFINITION
═══════════════════════════════════════════════════════════════

XXE = Injection into XML parsing via external entities.
      Allows reading local files, performing SSRF,
      or causing DoS (Billion Laughs attack).

OWASP : A05:2021 (Security Misconfiguration)
CWE   : CWE-611

CLASSIC PAYLOAD :
  <?xml version="1.0"?>
  <!DOCTYPE foo [
    <!ENTITY xxe SYSTEM "file:///etc/passwd">
  ]>
  <root>&xxe;</root>

  → If the parser reads the external entity →
    contents of /etc/passwd in the response

SSRF PAYLOAD :
  <!ENTITY xxe SYSTEM "http://169.254.169.254/latest/meta-data/">

DoS PAYLOAD (Billion Laughs) :
  <!DOCTYPE bomb [
    <!ENTITY a "aaaa...aaaa">  (1000 chars)
    <!ENTITY b "&a;&a;&a;..."> (1000x a)
    <!ENTITY c "&b;&b;&b;..."> (1000x b)
  ]>
  → Exponential expansion → memory crash

═══════════════════════════════════════════════════════════════
               PATTERNS TO DETECT
═══════════════════════════════════════════════════════════════

VULNERABLE CONTEXTS :
  → XML file upload
  → SVG file upload (XML-based)
  → DOCX/XLSX file upload (ZIP containing XML)
  → API accepting Content-Type: application/xml
  → XML configuration parsing

VULNERABLE CODE :
  // PHP — Without disabling entities
  $doc = new DOMDocument()
  $doc->loadXML($userXml)  // Vulnerable by default

  // Java — SAXParser vulnerable by default in some versions
  SAXParser parser = SAXParserFactory.newInstance().newSAXParser()
  parser.parse(new InputSource(new StringReader(userXml)), handler)

  // Python — lxml secure, xml.etree.ElementTree also
  // BUT xmltodict with certain configs

  // Node.js — xml2js
  const result = await parseStringPromise(userXml) // Configuration ?

═══════════════════════════════════════════════════════════════
               REMEDIATION
═══════════════════════════════════════════════════════════════

DISABLE EXTERNAL ENTITIES :

  PHP :
    $doc = new DOMDocument()
    // Disable external entities
    libxml_disable_entity_loader(true) // PHP < 8.0
    // PHP 8.0+ : disabled by default
    $doc->loadXML($userXml, LIBXML_NOENT | LIBXML_DTDLOAD)
    // Better : use LIBXML_NONET to block network

  NODE.JS with xml2js :
    import { parseString } from 'xml2js'
    // xml2js does not expand external entities by default ✅

  NODE.JS with fast-xml-parser :
    import { XMLParser } from 'fast-xml-parser'
    const parser = new XMLParser({
      allowBooleanAttributes: false,
      processEntities: false,  // Disable entities
    })

  RECOMMENDED ALTERNATIVE :
    // Use JSON instead of XML when possible
    // JSON does not have this problem

  FOR SVG UPLOADS :
    // Reject SVGs with DTD or external entities
    // Reprocess SVGs with sharp to eliminate dangerous XML
    import sharp from 'sharp'
    const safePng = await sharp(svgBuffer).png().toBuffer()
