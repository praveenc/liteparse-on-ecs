# LiteParse on ECS

Self-hosted document parsing on AWS. Drop in a DOCX, PDF, or spreadsheet and get structured text back. Everything stays inside your VPC.

This runs [LiteParse](https://github.com/run-llama/liteparse) (the open-source layout-aware parser from LlamaIndex) on ECS Fargate behind an internal ALB, with a Lambda-powered S3 pipeline for async processing. Deployed via CDK.

---

## Quick Start

**Deploy the stack:**

```bash
cd infra
npm install
npx cdk bootstrap   # first time only
npx cdk deploy
```

**Run the local UI:**

```bash
cd ui
npm install
npm start
```

Open [https://liteparse.localhost](https://liteparse.localhost) and drag a file in. That's it. You'll see the parsed text and can download `.txt` or `.json` results.

The local UI uses [Portless](https://portless.sh/) for a stable named URL instead of `localhost:3000`. On first run it'll prompt once to trust the local CA.

---

## How It Works

There are three ways to use the service, depending on your workflow:

### 1. Local Web UI

The simplest option. A drag-and-drop interface that uploads your file to S3, waits for it to be parsed, and shows the result. Good for ad-hoc use or quick testing.

```bash
cd ui && npm start
# https://liteparse.localhost
```

### 2. S3 Pipeline (event-driven)

Upload a file to the `raw/` prefix in S3 and walk away. A Lambda picks it up, sends it to the parsing service, and writes the output to `processed/`. Useful for batch workflows or integrations that already produce files in S3.

```bash
aws s3 cp report.docx s3://liteparse-docs-ACCOUNT_ID/raw/20260523/report.docx

# A few seconds later:
aws s3 ls s3://liteparse-docs-ACCOUNT_ID/processed/20260523/
#   report.docx.txt
#   report.docx.json
```

### 3. Direct API

For services running inside the VPC that want synchronous results. POST a file, get text or JSON back immediately.

```bash
# Plain text
curl -X POST "http://<ALB_DNS>/parse?text=true" -F "file=@document.docx"

# Structured JSON (pages with bounding boxes)
curl -X POST "http://<ALB_DNS>/parse" -F "file=@document.pdf"

# Page screenshots as NDJSON stream of base64 PNGs
curl -X POST "http://<ALB_DNS>/screenshots?pages=1,2" -F "file=@document.pdf"
```

---

## Supported Formats

PDF, DOCX, XLSX, PPTX, PNG, and JPG. Images go through Tesseract.js OCR automatically.

---

## Architecture

```
+------------------------------------------------------------------+
| VPC (2 AZs, 1 NAT Gateway)                                       |
|                                                                  |
|  +----------+     +--------------+     +-------------------+     |
|  |  Lambda  |---->| Internal ALB |---->| ECS Fargate Task  |     |
|  | (ARM64)  |     |  (port 80)   |     | (liteparse:5000)  |     |
|  +----+-----+     +--------------+     +-------------------+     |
|       |                                                          |
|       v                                                          |
|  +---------------------------------------------------------+     |
|  | S3: liteparse-docs-{account-id}                         |     |
|  |   raw/YYYYMMDD/file.docx       <-- triggers Lambda      |     |
|  |   processed/YYYYMMDD/file.docx.txt   <-- text output    |     |
|  |   processed/YYYYMMDD/file.docx.json  <-- JSON output    |     |
|  +---------------------------------------------------------+     |
|                         |                                        |
|                  S3 VPC Endpoint (free)                          |
+------------------------------------------------------------------+
```

The local UI sits outside the VPC. It talks to S3 directly using your AWS credentials, and the S3 event notification triggers the same Lambda pipeline.

**Key design choices:**

- The ALB is internal (not internet-facing). Network isolation is the security boundary.
- The ECS task runs the [pre-built LiteParse server image](https://github.com/run-llama/liteparse) from GHCR. No custom Dockerfile.
- Auto-scaling (1 to 4 tasks) tracks CPU at 70%. One task handles low traffic; bursts scale out.
- The S3 bucket has a stable name (`liteparse-docs-{account-id}`), versioning enabled, and lifecycle rules that transition to Standard-IA at 30 days and expire at 90 days.

---

## Configuration

| Setting | Default | What it does |
|---------|---------|--------------|
| `--context enableExec=true` | off | Enables ECS Exec (SSM shell/port-forward into the task) |
| `LITEPARSE_BUCKET` env var | `liteparse-docs-{account-id}` | Override the S3 bucket used by the local UI |

---

## Debugging

Deploy with ECS Exec enabled to get a direct tunnel to the container:

```bash
npx cdk deploy --context enableExec=true
```

Then port-forward to test the service without going through S3:

```bash
aws ssm start-session \
  --target "ecs:CLUSTER_TASK_RUNTIMEID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["5000"],"localPortNumber":["15000"]}' \
  --region us-west-2

# Now you can curl directly:
curl -X POST "http://localhost:15000/parse?text=true" -F "file=@test.pdf"
```

---

## Cost

| Component | Monthly |
|-----------|---------|
| Fargate (1 task, 1 vCPU / 4 GB) | ~$30 |
| NAT Gateway + data transfer | ~$30 |
| ALB | ~$16 |
| Lambda, S3, CloudWatch | < $2 |
| **Total (idle)** | **~$77** |

The NAT gateway is the obvious optimization target. A VPC endpoint for GHCR would eliminate it for image pulls, but that's a future consideration.

---

## Stack Outputs

After `cdk deploy`, you'll see:

| Output | Value |
|--------|-------|
| `ServiceUrl` | Internal ALB DNS (for direct API calls from within VPC) |
| `BucketName` | `liteparse-docs-{account-id}` |
| `ParseFunctionName` | Lambda function name |
| `ParseFunctionArn` | Lambda function ARN |

---

## Project Layout

```
infra/
  bin/infra.ts                CDK app entry point
  lib/infra-stack.ts          Stack: VPC, ECS, ALB, S3, Lambda, alarms
  lib/lambda/parse-handler.ts S3 event handler (download -> parse -> write)

ui/
  server.ts                   Express server (upload, poll, preview, download)
  public/index.html           Drag-and-drop frontend

docs/
  architecture-decisions.md   Full design rationale and ADRs
  liteparse-overview.md       What LiteParse is and how it works
  hosting-liteparse-on-ecs.md Background research on ECS hosting
```

---

## Further Reading

- [Architecture Decisions](docs/architecture-decisions.md): Why ECS over Lambda, X86_64 over ARM, and everything else.
- [LiteParse Overview](docs/liteparse-overview.md): How LiteParse's three-stage pipeline works.
- [LiteParse Server API](https://developers.llamaindex.ai/liteparse/guides/server-usage/#api-specification): Official endpoint documentation.
