# ☁️ CLOUD REMEDIATION LIBRARY — CYBERAUDIT SKILL

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PUBLIC S3 BUCKET
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DETECT:
  aws s3api get-public-access-block --bucket X
  aws s3api get-bucket-acl --bucket X
  aws s3api get-bucket-policy --bucket X

FIX Terraform:
```hcl
resource "aws_s3_bucket_public_access_block" "block" {
  bucket = aws_s3_bucket.app.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "enc" {
  bucket = aws_s3_bucket.app.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "aws:kms", kms_master_key_id = aws_kms_key.s3.arn } }
}
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WILDCARD IAM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DETECT:
  iam:* , s3:* on Resource "*"

FIX — Least privilege example:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject"],
    "Resource": "arn:aws:s3:::app-prod-uploads/user/${aws:userid}/*"
  }]
}
```
Terraform scope:
```hcl
resource "aws_iam_policy" "scoped" {
  policy = jsonencode({
    Statement = [{ Action = ["s3:GetObject","s3:PutObject"], Resource = "${aws_s3_bucket.uploads.arn}/*" }]
  })
}
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OPEN SECURITY GROUP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIX:
```hcl
# ❌ Before
ingress { from_port=22 to_port=22 protocol="tcp" cidr_blocks=["0.0.0.0/0"] }

# ✅ After — bastion only
ingress { from_port=22 to_port=22 protocol="tcp" security_groups=[aws_security_group.bastion.id] }

# Redis/Mongo never public
# Use private subnet + SecurityGroup only app SG
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SSRF → IMDS CREDENTIAL THEFT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIX 1 — Enforce IMDSv2 on EC2:
```hcl
resource "aws_instance" "app" {
  metadata_options {
    http_tokens = "required" # enforce v2
    http_endpoint = "enabled"
  }
}
```
FIX 2 — Block metadata in app:
```ts
// URL validation before fetch
const ALLOWED = ["api.stripe.com","api.example.com"];
const url = new URL(userInput);
if (!ALLOWED.includes(url.hostname)) throw new Error("Domain not allowed");
if (url.hostname === "169.254.169.254" || url.hostname === "metadata.google.internal") throw new Error("Blocked");
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECRETS IN IaC / ENV
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIX:
```hcl
# ❌ Don't
resource "aws_ssm_parameter" "secret" { value = "supersecret" }

# ✅ Use Secrets Manager
resource "aws_secretsmanager_secret" "api_key" { name = "prod/api-key" }
# Reference in Lambda via extension or SDK, not env plaintext
```

For Terraform state:
```hcl
terraform {
  backend "s3" {
    bucket = "tf-state-prod"
    key    = "app/terraform.tfstate"
    region = "eu-west-1"
    encrypt = true
    dynamodb_table = "tf-lock"
  }
}
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAMBDA PUBLIC URL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIX:
```hcl
# Require IAM auth
resource "aws_lambda_function_url" "url" {
  authorization_type = "AWS_IAM" # not NONE
}
```

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CLOUDTRAIL NOT ENABLED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIX:
```hcl
resource "aws_cloudtrail" "main" {
  name = "org-trail"
  s3_bucket_name = aws_s3_bucket.trail.id
  is_multi_region_trail = true
  enable_logging = true
  kms_key_id = aws_kms_key.trail.arn
}
```
Enable alert:
```hcl
resource "aws_cloudwatch_metric_alarm" "root" {
  alarm_name = "RootLogin"
  metric_name = "RootLogin"
  # ... filter CloudTrail root login
}
```
