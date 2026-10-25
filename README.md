# KnowledgeBridge AI

A single AWS-backed tool that lets an existing **n8n AI Agent** (Groq + memory + Supabase + Google Calendar) retrieve business knowledge stored in a private Amazon S3 bucket. Built for the AWS Weekend Challenge: *"Give your Agent a Tool."*

The tool is one AWS Lambda function. The agent calls it through n8n's **AWS Lambda node**, attached to the AI Agent's Tool port. The Lambda reads `business-knowledge.json` from S3 and returns a structured response with the content and the S3 source. No API Gateway, no Function URL — n8n invokes Lambda directly via the AWS SDK with SigV4-signed requests, so authentication is **AWS_IAM** end-to-end.

---

## Architecture

![KnowledgeBridge AI Architecture](https://github.com/LuthiraPeiris/knowledgebridge-ai/blob/d675e1101ae29f7ed55a9e3633410d5e65dfd0e6/docs/architecture/knowledgebridge-architecture.png)

---

## File structure

```
.
├── src/
│   └── index.mjs                   # Lambda handler (Node.js 22.x, ES modules, AWS SDK v3)
├── data/
│   └── business-knowledge.json      # Fictional, non-sensitive test dataset (uploaded to S3)
├── infra/
│   ├── lambda-trust-policy.json      # Trust policy for the Lambda execution role
│   ├── lambda-s3-policy.json        # Inline S3 GetObject policy (exact object only)
│   └── n8n-caller-policy.json        # Inline InvokeFunction policy for the n8n IAM user
├── test/
│   └── payloads/                    # Sample payloads for `aws lambda invoke`
│       ├── topic-hours.json
│       ├── topic-services.json
│       ├── topic-pricing.json
│       ├── topic-invalid.json        # Exercises input validation (bad characters)
│       └── no-topic.json             # Returns the full document
├── .gitignore
├── package.json
├── README.md                        # ← you are here
└── DEPLOYMENT.md                     # Exact PowerShell deploy / test / cleanup commands
```

---

## AWS resources (4)

| Resource | Purpose | Notes |
|---|---|---|
| **S3 bucket** `kb-ai-business-knowledge-<suffix>` | Holds `business-knowledge.json` | Private. Public access fully blocked. AES256 server-side encryption. |
| **Lambda function** `knowledgebridge-ai` | Reads the object, returns structured JSON | Node.js 22.x, 256 MB, 10 s timeout. Env vars: `BUCKET_NAME`, `OBJECT_KEY`. |
| **Lambda execution role** `kb-ai-lambda-role` | Lets Lambda read the object + write logs | `AWSLambdaBasicExecutionRole` (managed, logs) + inline `s3:GetObject` on the **exact object ARN only**. |
| **IAM user** `n8n-kb-ai-caller` | Identity used by n8n | Programmatic access (access key + secret). Inline policy: `lambda:InvokeFunction` on **this function only**. |

A CloudWatch log group `/aws/lambda/knowledgebridge-ai` is auto-created by Lambda on first invocation. No API Gateway, no Function URL, no KMS, no Secrets Manager.

---

## Security model

- **Least-privilege IAM, scoped to exact ARNs.**
  - Lambda role: `s3:GetObject` on `arn:aws:s3:::<bucket>/business-knowledge.json` only — no list, no bucket-wide access, no other S3 actions.
  - n8n IAM user: `lambda:InvokeFunction` on `arn:aws:lambda:ap-south-1:<account>:function:knowledgebridge-ai` only — cannot invoke any other function, cannot list, cannot read S3.
- **No root credentials in n8n.** n8n uses a dedicated IAM user with one inline policy. Never the root account, never an admin user.
- **No secrets in source code or Git.** AWS credentials live in n8n's encrypted credential store. The `.gitignore` excludes `access-keys.json`, `.env`, and resolved policy files. The Lambda handler reads only `BUCKET_NAME` and `OBJECT_KEY` from environment variables — no keys, no tokens.
- **Private bucket.** BlockPublicAccess is fully on; the object is never made public. The only path to the object is through the Lambda execution role.
- **End-to-end AWS_IAM.** n8n's AWS Lambda node signs requests with SigV4 using the IAM user's keys; Lambda's resource policy + the user's identity policy both permit the call.
- **Input validation.** The `topic` field is constrained to `/^[A-Za-z0-9_-]{1,64}$/`. Anything else is rejected with `status: invalid_input` before any S3 call is made.
- **No PII.** The dataset is fictional business info (Northwind Botanicals). Email/phone use the `.example` reserved domain and the `+1-555-0100` fictional-number range.

---

## n8n integration (the important part)

This is how the existing AI Agent gets the new tool. Three steps in n8n; nothing in this repo gets modified.

### 1. Add the AWS credential in n8n

1. In n8n, open **Credentials → Add credential**.
2. Search for **AWS** and select the **AWS (IAM)** credential type (the access-key method, not "AWS (Assume Role)").
3. Fill in:
   - **Region** — `ap-south-1`.
   - **Access Key ID** — printed to your PowerShell console in `DEPLOYMENT.md` Step 6 (also saved to `access-keys.json`).
   - **Secret Access Key** — same source.
4. Save as **"KnowledgeBridge AI AWS (ap-south-1)"**.

n8n encrypts credentials at rest. After saving, you can delete the local `access-keys.json` (it's gitignored anyway). See **Credential handling & rotation** below.

### 2. Add the AWS Lambda node as a tool

1. Open your existing AI Agent workflow.
2. Click **+** to add a node, search **AWS Lambda**, drag it onto the canvas.
3. In the node config:
   - **Credential to connect with**: select **KnowledgeBridge AI AWS (ap-south-1)**.
   - **Operation**: `Invoke` (the only option).
   - **Function Name or ID**: toggle the field to **Expression** mode (click the `=` icon) and enter `'knowledgebridge-ai'` (or enter the function name `knowledgebridge-ai` directly).
     > **Note on least privilege:** The `n8n-kb-ai-caller` IAM user is scoped strictly to `lambda:InvokeFunction` on this specific function ARN and does not have account-wide `lambda:ListFunctions` permissions. Therefore, n8n cannot auto-populate the dropdown list; specifying the name directly preserves zero-trust least privilege.
   - **Qualifier**: leave as `$LATEST` (we don't publish versions for the demo).
   - **Invocation Type**: leave as **Wait for Results** (`RequestResponse`) — the agent needs the response.
   - **JSON Input** (the payload Lambda receives as `event`): use the **expression editor** (toggle the field with `=` if needed) and paste:

       ```
       {"topic": "{{ $fromAI('topic', 'Business knowledge topic to look up. Valid values: business, hours, services, pricing, contact, serviceArea, policies, faq. Leave empty to retrieve the full document.', 'string', '') }}"}
       ```

       `$fromAI()` is n8n's mechanism for a tool parameter the model fills at call time. The `description` is what tells the model what to put there. If you prefer the JS-expression form, this is equivalent:

       ```
       ={{ JSON.stringify({ topic: $fromAI('topic', 'Business knowledge topic to look up. Valid values: business, hours, services, pricing, contact, serviceArea, policies, faq. Leave empty to retrieve the full document.', 'string', '') }) }}
       ```

4. Open the node's **Settings** tab and set:
   - **Tool name**: `knowledgebase`
   - **Tool description**:

       > Use this tool to retrieve business knowledge from the company knowledge base stored in Amazon S3. Call it whenever the user asks about business hours, services, pricing, contact info, service area, return/refund/privacy policies, or any company-specific information. Pass `topic` with one of: business, hours, services, pricing, contact, serviceArea, policies, faq. Leave `topic` empty to retrieve the full knowledge base. The tool's response is wrapped in a `result` object by n8n's AWS Lambda node — look inside `result.content` (or `content`) for the knowledge content and `result.source` (or `source`) for the S3 source metadata (bucket, key, region, retrievedAt).

5. Save the node. n8n detects it as a tool automatically (the AWS Lambda node has `usableAsTool: true`).

### 3. Connect it to the AI Agent's Tool port

1. Drag from the AWS Lambda node's **output** connector to the AI Agent node's **Tools** input port.
2. Save the workflow. The Tools port should show `knowledgebase` attached.
3. Test from the AI Agent chat:
   - **"What are your business hours?"** → agent calls `knowledgebase` with `topic=hours`, reads `result.content.hours` from the response, and answers.
   - **"Tell me about your pricing."** → `topic=pricing`.
   - **"Where do you ship?"** → `topic=serviceArea`.
   - **"What's your refund policy?"** → `topic=policies`.
   - Ask the agent to **cite its source** → it should reference the `source` object (`bucket`, `key`, `region`, `retrievedAt`) inside `result`.

> **Why `result.content`?** n8n's AWS Lambda node automatically encapsulates the Lambda execution payload within a `{ result: ... }` wrapper when returning data to the workflow and connected AI Agent tools. Direct AWS CLI invocations return fields at top level (`content`, `source`).

The existing Groq model, Simple Memory, Supabase tool, and Google Calendar tools are untouched. You are adding exactly one tool.

---

## Credential handling & rotation

The n8n IAM user has one access key. Treat it like a password.

**Storage**
- Lives in n8n's encrypted credential store only.
- The local `access-keys.json` produced during deploy is for copy-paste convenience and is gitignored. Delete it after you've entered the values into n8n.
- Never paste the secret into Slack, tickets, commits, or screenshots.

**Rotation (recommended every 90 days, or if you suspect a leak)**
1. In AWS, create a **second** access key for the same IAM user (AWS allows two active keys for zero-downtime rotation):
   ```powershell
   aws iam create-access-key --user-name n8n-kb-ai-caller
   ```
2. Update the n8n AWS credential with the new Access Key ID + Secret. Save. Test the tool.
3. Deactivate and delete the old key:
   ```powershell
   aws iam update-access-key --access-key-id OLD_AKIA... --status Inactive --user-name n8n-kb-ai-caller
   aws iam delete-access-key --access-key-id OLD_AKIA... --user-name n8n-kb-ai-caller
   ```
4. Run a final smoke test from n8n to confirm only the new key is in use.

**Least privilege makes rotation low-risk** — the worst a compromised key can do is invoke this one Lambda function, which only reads one public-facing JSON file.

---

## Local development

The project has one runtime dependency — `@aws-sdk/client-s3` — declared in `package.json` and pinned in `package-lock.json`. Install it once before running tests:

```powershell
npm install
```

To run syntax verification and the automated unit test suite locally:

```powershell
# 1. Syntax check
node --check src/index.mjs

# 2. Run automated unit tests (24 tests covering extraction, prompt injection defense, S3 parsing, and policies)
npm test
```

The unit tests inject a mock S3 client as the handler's third argument. The handler uses the mock only when it has a callable `.send` method; in production, AWS Lambda passes its `callback` as that argument (no `.send` method), so the handler transparently falls back to the real AWS SDK client. This is what keeps tests hermetic without exposing AWS to the test runner.

> **Note on AWS testing:** Local unit tests validate logic using simulated/mock S3 responses. To test real AWS integration end-to-end, follow `DEPLOYMENT.md` to deploy resources to `ap-south-1` and invoke the function.

---

## Deploy & test

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for exact Windows PowerShell commands to:
- Create the S3 bucket and upload the dataset.
- Create the Lambda role with least-privilege S3 access.
- Build the zip and create the function.
- Test all four scenarios (specific topic, full doc, invalid input, multiple topics).
- Create the n8n IAM user and access key.
- Clean up every billable resource when done.

Nothing is deployed automatically. You run every command yourself.

---

## Limitations & future hardening

Intentionally scoped for the one-day challenge. Not included:

- **No caching** — each invocation reads the object. Acceptable for the demo's low call volume.
- **No multi-bucket / multi-object support** — the role and handler are scoped to one object. Adding more objects means editing the inline policy and the handler's `topic` matching.
- **No API Gateway / Function URL** — the only caller is n8n via the Invoke API. If you need an HTTP endpoint later, add a Function URL with `AuthType=AWS_IAM` and adjust the response envelope in the handler.
- **No IaC framework** — plain AWS CLI + JSON policy files keep the implementation readable for review. SAM/CDK/Terraform is a straightforward follow-up.
- **No CloudWatch alarms** — logs are captured but no alarm fires on errors. Add a metric filter + alarm for production use.
- **No WAF / rate limiting** — N/A since there's no HTTP endpoint exposed.

---
