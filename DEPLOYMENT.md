# Deployment (Windows PowerShell)

Step-by-step AWS CLI commands to deploy, test, and tear down KnowledgeBridge AI. All commands target **`ap-south-1`** and use **Windows PowerShell**. Run them yourself, in order, from the repository root.

> **Stop and read before each step.** Nothing here is automated. You are creating real AWS resources that bill real money (a few cents for the demo, but real). Run **Cleanup** at the end.

---

## Prerequisites

1. **AWS CLI v2** installed and on your PATH. Verify:
   ```powershell
   aws --version
   # Expect: aws-cli/2.x.x ...
   ```
2. **PowerShell 5.1+ or PowerShell 7+.** Verify:
   ```powershell
   $PSVersionTable.PSVersion
   ```
3. **AWS credentials configured locally** with sufficient privileges to create S3 buckets, IAM users/roles/policies, and Lambda functions. A power-user or admin role on your workstation is fine for the deploy; **the n8n side will use a dedicated least-privilege IAM user**, not your deploy credentials.
   ```powershell
   aws sts get-caller-identity
   ```
   Note the **Account** value returned — you'll use it below.
4. **Node.js 22.x locally** (optional, only for `node --check src/index.mjs`). The Lambda runtime itself doesn't require this.

---

## 0. Set variables (run once per shell session)

Paste this block into your PowerShell session before running any later step. Re-run it if you close the window.

```powershell
# --- Configuration ----------------------------------------------------------
$Region         = "ap-south-1"
$FunctionName   = "knowledgebridge-ai"
$RoleName       = "kb-ai-lambda-role"
$S3PolicyName   = "kb-ai-read-business-knowledge"
$N8nUserName    = "n8n-kb-ai-caller"
$N8nPolicyName  = "kb-ai-invoke-lambda"
$ObjectKey      = "business-knowledge.json"

# S3 bucket names are globally unique. Generate a 6-char random suffix.
$Suffix     = -join ((48..57) + (97..122) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
$BucketName = "kb-ai-business-knowledge-$Suffix"

# Capture your 12-digit AWS account ID (used in the n8n caller policy).
$AccountId = (aws sts get-caller-identity --query Account --output text)

# Sanity check the values.
Write-Host "Region:       $Region"
Write-Host "FunctionName: $FunctionName"
Write-Host "BucketName:    $BucketName"
Write-Host "AccountId:    $AccountId"
Write-Host "RoleName:     $RoleName"
Write-Host "N8nUserName:  $N8nUserName"

# Helper: write BOM-free UTF-8. (Windows PowerShell 5.1's `Out-File -Encoding utf8`
# adds a BOM that the AWS CLI's JSON parser rejects; this works on both 5.1 and 7+.)
function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}
```

If any value looks wrong, stop and fix it before continuing. Don't proceed if `$AccountId` is empty.

---

## 1. Create the S3 bucket and upload the dataset

```powershell
# 1. Create the S3 bucket (LocationConstraint is required for regions other than us-east-1).
aws s3api create-bucket `
  --bucket $BucketName `
  --create-bucket-configuration LocationConstraint=$Region `
  --region $Region

# 2. Block ALL public access — the bucket stays private.
# Using AWS CLI shorthand syntax ensures robust execution across both Windows PowerShell 5.1 and PowerShell 7+.
aws s3api put-public-access-block `
  --bucket $BucketName `
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true" `
  --region $Region

# 3. Server-side encryption with AES256 (SSE-S3).
# Note: Amazon S3 applies SSE-S3 default encryption automatically to all new buckets since Jan 2023 at no extra cost.
# Running put-bucket-encryption explicitly confirms the configuration:
aws s3api put-bucket-encryption `
  --bucket $BucketName `
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' `
  --region $Region

# 4. Upload the fictional business knowledge document.
aws s3 cp "data/business-knowledge.json" "s3://$BucketName/$ObjectKey" --region $Region

# 5. Verify it's there and the bucket is private.
aws s3 ls "s3://$BucketName/" --region $Region
```

---

## 2. Create the Lambda execution role (least-privilege)

```powershell
# Create the role with a trust policy that lets Lambda assume it.
aws iam create-role `
  --role-name $RoleName `
  --assume-role-policy-document file://infra/lambda-trust-policy.json

# Attach the AWS-managed policy that lets Lambda write to CloudWatch Logs.
aws iam attach-role-policy `
  --role-name $RoleName `
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"

# Resolve the inline S3 policy with the actual bucket name and apply it.
$s3Policy = (Get-Content -Raw -Path infra/lambda-s3-policy.json) -replace 'REPLACE_BUCKET_NAME', $BucketName
Write-Utf8NoBom -Path "infra/lambda-s3-policy.resolved.json" -Content $s3Policy

aws iam put-role-policy `
  --role-name $RoleName `
  --policy-name $S3PolicyName `
  --policy-document file://infra/lambda-s3-policy.resolved.json

# Verify the role and its inline policy.
aws iam get-role --role-name $RoleName --query 'Role.Arn' --output text
aws iam get-role-policy --role-name $RoleName --policy-name $S3PolicyName --query 'PolicyDocument.Statement' --output json
```

The inline policy grants **only** `s3:GetObject` on `arn:aws:s3:::$BucketName/business-knowledge.json`. The role cannot list the bucket, cannot read any other object, and has no other S3 permissions.

---

## 3. Build the Lambda deployment package

The deployment archive includes the handler AND the runtime dependencies (`@aws-sdk/client-s3` and transitive deps) so the function uses the exact SDK version pinned in `package-lock.json`, independent of whatever version the Lambda runtime happens to bundle.

```powershell
# Clean and recreate the build/dist dirs.
Remove-Item -Path build, dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path dist, build | Out-Null

# Stage the handler and the npm manifests.
Copy-Item -Path src/index.mjs -Destination build/index.mjs -Force
Copy-Item -Path package.json -Destination build/package.json -Force
Copy-Item -Path package-lock.json -Destination build/package-lock.json -Force

# Install production-only dependencies into build/node_modules (reproducible: uses the lockfile).
Push-Location build
npm ci --omit=dev
Pop-Location

# The npm manifests are no longer needed at runtime — drop them so they don't pollute the zip.
Remove-Item -Path build/package.json, build/package-lock.json -Force

# Zip the build/ contents from inside build/ so entries sit at the zip root (index.mjs at root,
# node_modules/ alongside). This matches the Lambda handler config `index.handler`.
Push-Location build
Compress-Archive -Path * -DestinationPath ../dist/lambda.zip
Pop-Location

# Verify the zip: index.mjs at the root AND node_modules/@aws-sdk/client-s3 present.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path dist/lambda.zip))
$hasIndex   = $zip.Entries | Where-Object { $_.FullName -eq 'index.mjs' }
$hasClient3 = $zip.Entries | Where-Object { $_.FullName -eq 'node_modules/@aws-sdk/client-s3/package.json' }
Write-Host ("zip entries:        {0}" -f $zip.Entries.Count)
Write-Host ("index.mjs at root:  {0} ({1} bytes)" -f [bool]$hasIndex, $(if ($hasIndex) { $hasIndex.Length } else { 0 }))
Write-Host ("@aws-sdk/client-s3: {0}" -f [bool]$hasClient3)
$zip.Dispose()
```

The verification should print `index.mjs at root: True` and `@aws-sdk/client-s3: True`. If `index.mjs` is missing from the root, the Lambda handler `index.handler` won't resolve. Expected zip size is ~3 MB.

**Notes:**
- `npm ci --omit=dev` requires `package-lock.json` to be in sync with `package.json`. If you change dependencies, run `npm install` first to regenerate the lockfile, then re-run this step.
- This requires an internet connection on the machine running the build (to fetch packages from the npm registry).
- If you prefer to ship the existing `node_modules` instead of reinstalling, replace the `npm ci` block with `Copy-Item -Path node_modules -Destination build/node_modules -Recurse -Force` — equivalent here because the project has no devDependencies.

---

## 4. Create the Lambda function

```powershell
# Look up the role ARN we created in step 2.
$RoleArn = (aws iam get-role --role-name $RoleName --query 'Role.Arn' --output text)

aws lambda create-function `
  --function-name $FunctionName `
  --runtime nodejs22.x `
  --role $RoleArn `
  --handler index.handler `
  --zip-file fileb://dist/lambda.zip `
  --environment "Variables={BUCKET_NAME=$BucketName,OBJECT_KEY=$ObjectKey}" `
  --region $Region `
  --timeout 10 `
  --memory-size 256

# Wait for it to become active.
aws lambda wait function-active --function-name $FunctionName --region $Region
Write-Host "Lambda $FunctionName is active."
```

> **IAM Propagation Note:** IAM roles take 5–10 seconds to propagate across all AWS control planes. If `create-function` returns `InvalidParameterValueException: The role defined for the function cannot be assumed by Lambda`, wait 5–10 seconds and re-run the `create-function` command.

---

## 5. Test from PowerShell (4 scenarios)

These run the function locally with your deploy credentials — they prove the Lambda + S3 + IAM role wiring is correct, independent of n8n.

```powershell
# --- 5a. Specific topic --------------------------------------------------
aws lambda invoke `
  --function-name $FunctionName `
  --payload file://test/payloads/topic-hours.json `
  --cli-binary-format raw-in-base64-out `
  --region $Region `
  response-hours.json
Get-Content response-hours.json

# Expected: status="ok", content.hours="Mon–Fri 09:00–17:00 PT...".

# --- 5b. A different topic ------------------------------------------------
aws lambda invoke `
  --function-name $FunctionName `
  --payload file://test/payloads/topic-services.json `
  --cli-binary-format raw-in-base64-out `
  --region $Region `
  response-services.json
Get-Content response-services.json

# --- 5c. No topic — returns the full document ---------------------------
aws lambda invoke `
  --function-name $FunctionName `
  --payload file://test/payloads/no-topic.json `
  --cli-binary-format raw-in-base64-out `
  --region $Region `
  response-all.json
Get-Content response-all.json

# --- 5d. Invalid input — exercises input validation --------------------
aws lambda invoke `
  --function-name $FunctionName `
  --payload file://test/payloads/topic-invalid.json `
  --cli-binary-format raw-in-base64-out `
  --region $Region `
  response-invalid.json
Get-Content response-invalid.json

# Expected: status="invalid_input", error explaining the topic regex.
```

**Pass criteria for steps 5a/5b:** JSON contains `"status":"ok"`, a `"source"` object with `bucket`, `key`, `region`, `retrievedAt`, and a `"content"` object with the requested key.

**Pass criteria for 5c:** `"status":"ok"`, `"content"` contains the full business knowledge object.

**Pass criteria for 5d:** `"status":"invalid_input"`, `"source":null` (no S3 metadata — confirms the function short-circuited before calling S3), `"requestedTopic":"bad!chars"`, and the response arrived in well under the 10 s timeout (input validation rejects before any S3 round trip).

You can also pretty-print any response:
```powershell
Get-Content response-hours.json -Raw | ConvertFrom-Json | ConvertTo-Json -Depth 6
```

If any of these fail, check CloudWatch Logs:
```powershell
aws logs filter-log-events `
  --log-group-name "/aws/lambda/$FunctionName" `
  --region $Region `
  --limit 20 --query 'events[*].message' --output text
```

---

## 6. Create the n8n IAM user and access key

This is the identity n8n will use to invoke the Lambda. It is **not** root, **not** an admin — it can do exactly one thing: invoke this one function.

```powershell
# Create the user.
aws iam create-user --user-name $N8nUserName

# Create an access key. AWS shows the SecretAccessKey in plaintext only this once.
# Capture as JSON so we can both display it and save a BOM-free copy.
$accessKeyJson = aws iam create-access-key --user-name $N8nUserName --output json
$accessKey = ($accessKeyJson | ConvertFrom-Json).AccessKey

# Display the keys — copy them into n8n right now.
Write-Host "AccessKeyId:     $($accessKey.AccessKeyId)"
Write-Host "SecretAccessKey: $($accessKey.SecretAccessKey)"
Write-Host "Region:          $Region"

# Also save to access-keys.json (gitignored) so you can refer back later if
# you forget to copy a value. Safe to delete once it's in n8n.
Write-Utf8NoBom -Path "access-keys.json" -Content $accessKeyJson

# Apply the InvokeFunction policy, scoped to this function only.
$n8nPolicy = (Get-Content -Raw -Path infra/n8n-caller-policy.json) -replace 'REPLACE_ACCOUNT_ID', $AccountId
Write-Utf8NoBom -Path "infra/n8n-caller-policy.resolved.json" -Content $n8nPolicy

aws iam put-user-policy `
  --user-name $N8nUserName `
  --policy-name $N8nPolicyName `
  --policy-document file://infra/n8n-caller-policy.resolved.json

# Verify the user has only the one inline policy.
aws iam list-user-policies --user-name $N8nUserName --query 'PolicyNames' --output text
```

**Copy the Access Key ID and Secret Access Key into the n8n AWS credential now** (see README.md → "n8n integration"). After saving the n8n credential, you can delete the local file:

```powershell
Remove-Item -Path access-keys.json -Force
```

`access-keys.json` is in `.gitignore`. Never paste the secret anywhere except the n8n credential editor.

---

## 7. Wire up n8n

This step is in the n8n UI, not the CLI. Follow **README.md → "n8n integration"**:
1. Add the AWS credential in n8n with the access key + secret + region from Step 6.
2. Add the AWS Lambda node, configure it as a tool:
   - `Operation: Invoke`
   - `Function Name or ID`: Toggle to **Expression** mode (`=`) and enter `'knowledgebridge-ai'` (due to least privilege, `n8n-kb-ai-caller` does not have account-wide `ListFunctions`).
   - `JSON Input`: Paste `{"topic": "{{ $fromAI('topic', ...) }}"}`
3. Connect it to the AI Agent's Tool port.
4. Ask the agent: *"What are your business hours?"* — it should call the tool and answer with the S3 source cited.

---

## Cleanup

Run this when you're done with the challenge to remove every billable resource. The order matters — IAM entities attached to a role must be detached before the role can be deleted, the Lambda must be deleted before its role, and the S3 object must be removed before the bucket can be deleted.

```powershell
# Pre-flight check: ensure required session variables exist before cleanup.
if (-not $BucketName -or -not $FunctionName -or -not $RoleName -or -not $N8nUserName) {
    Write-Error "One or more required variables (`$BucketName, `$FunctionName, `$RoleName, `$N8nUserName) are empty. Please run Step 0 (Set variables) in this PowerShell session before running Cleanup."
    return
}

# --- Delete the n8n IAM user ---------------------------------------------
# Delete all access keys (in case a second key was created during rotation).
$akIds = (aws iam list-access-keys --user-name $N8nUserName --query 'AccessKeyMetadata[].AccessKeyId' --output text) -split '\s+'
foreach ($akId in $akIds) {
    if ($akId -and $akId.Trim()) {
        aws iam delete-access-key --access-key-id $akId.Trim() --user-name $N8nUserName
    }
}

aws iam delete-user-policy --user-name $N8nUserName --policy-name $N8nPolicyName
aws iam delete-user --user-name $N8nUserName

# --- Delete the Lambda function ----------------------------------------
aws lambda delete-function --function-name $FunctionName --region $Region

# --- Delete the Lambda execution role ----------------------------------
aws iam delete-role-policy --role-name $RoleName --policy-name $S3PolicyName
aws iam detach-role-policy --role-name $RoleName --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
aws iam delete-role --role-name $RoleName

# --- Empty and delete the S3 bucket ------------------------------------
aws s3 rm "s3://$BucketName" --recursive --region $Region
aws s3api delete-bucket --bucket $BucketName --region $Region

# --- Delete the CloudWatch log group (created on first invocation) -----
aws logs delete-log-group --log-group-name "/aws/lambda/$FunctionName" --region $Region 2>$null

# --- Remove local artifacts --------------------------------------------
Remove-Item -Path "infra/lambda-s3-policy.resolved.json", "infra/n8n-caller-policy.resolved.json" -Force -ErrorAction SilentlyContinue
Remove-Item -Path "response-*.json" -Force -ErrorAction SilentlyContinue
Remove-Item -Path "access-keys.json" -Force -ErrorAction SilentlyContinue
Remove-Item -Path "dist", "build" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Cleanup complete. Verify nothing remains:"
aws lambda list-functions --region $Region --query "Functions[?FunctionName=='$FunctionName']" --output text
aws s3api list-buckets --query "Buckets[?Name=='$BucketName']" --output text
aws iam list-users --query "Users[?UserName=='$N8nUserName']" --output text
```

Each of the three verify commands at the end should return an empty result.

**Note on the log group:** `aws logs delete-log-group` will throw if the log group was never created (i.e., the function was never invoked). That is safely suppressed with `2>$null`.

---

## Estimated AWS costs & billing notes

All resources in this project are designed to stay well within the **AWS Free Tier**:

| Resource | Usage in Demo | Free Tier Allowance | Potential Cost if Beyond Free Tier |
|---|---|---|---|
| **Amazon S3** (Storage) | 1 object (~1.8 KB) | 5 GB standard storage free | ~$0.00000004 / month |
| **Amazon S3** (Requests) | < 100 GET requests | 20,000 GET requests free | $0.0004 per 1,000 requests |
| **AWS Lambda** (Compute) | ~4–20 invocations (256 MB, ~50 ms each) | 1,000,000 free requests / mo & 3.2M sec compute | $0.20 per 1,000,000 requests |
| **CloudWatch Logs** | < 1 MB ingestion & storage | 5 GB ingestion & 5 GB storage free | $0.50 per GB ingested |
| **AWS IAM** | 1 role, 1 user, 2 policies | Unlimited / Always free | $0.00 |
| **Encryption** | Default AES256 (SSE-S3) | Always free (no KMS key fee) | $0.00 |

**Expected total cost:** **$0.00** during normal testing within Free Tier, or less than **$0.01** even on an account where Free Tier has expired. Running the **Cleanup** steps removes all resources so no lingering charges can occur.

---

## Credential rotation

See **README.md → "Credential handling & rotation"**. The short version: create a second access key on the same IAM user, update the n8n credential, test, then deactivate and delete the old key. Zero downtime.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `AccessDenied` on `s3:GetObject` in Lambda logs | Inline S3 policy not attached, or bucket name typo in the resolved policy | Re-run step 2, verify `aws iam get-role-policy` shows the correct bucket ARN |
| `NoSuchKey` in Lambda logs | `OBJECT_KEY` env var doesn't match the uploaded object key | Verify `aws s3 ls s3://$BucketName/` shows `business-knowledge.json` |
| `InvalidParameterValueException: RuntimeInvalid` | Region doesn't support `nodejs22.x` | `ap-south-1` supports it; verify with `aws lambda list-runtimes --region ap-south-1` if you changed regions |
| n8n returns `AccessDeniedException` on invoke | n8n IAM user's policy missing or scoped wrong | Verify the resolved policy has the correct account ID and function name; check n8n is using the right credential |
| `--cli-binary-format` error | Older AWS CLI v1 in use | Install AWS CLI v2; v1 doesn't support `raw-in-base64-out` |
| `Compress-Archive` shows `build/index.mjs` in the zip | `Compress-Archive -Path build/*` from project root adds the `build/` prefix | Use the `Push-Location build; Compress-Archive -Path *; Pop-Location` form shown in Step 3 |
