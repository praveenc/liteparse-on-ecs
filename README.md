# LiteParse on ECS

A self-hosted document parsing service running [LiteParse](https://github.com/run-llama/liteparse) on AWS ECS Fargate, deployed with CDK.

## What It Does

Converts documents (DOCX, PDF, XLSX, PPTX, images) into structured text/JSON using LiteParse's layout-aware extraction. Runs entirely within your VPC — no data leaves your AWS account.

**Three usage modes:**

1. **Local Web UI** — Drag & drop files at `https://liteparse.localhost` (via [Portless](https://portless.sh/))
2. **Direct API** — POST files to the internal ALB and get parsed results immediately
3. **Event-driven** — Upload to S3 `raw/` and results appear automatically in `processed/`

## Architecture

```
+------------------------------------------------------------------+
| VPC (2 AZs, 1 NAT Gateway)                                       |
|                                                                  |
|   +----------+     +--------------+     +------------------+     |
|   |  Lambda  |---->| Internal ALB |---->| ECS Fargate Task |     |
|   | (ARM64)  |     |   (port 80)  |     | (liteparse:5000) |     |
|   +----+-----+     +--------------+     +------------------+     |
|        |                                                         |
|        v                                                         |
|   +----------------------------------------------------------+   |
|   | S3: liteparse-docs-{account-id}                          |   |
|   |   raw/YYYYMMDD/file.docx         <-- input (triggers Lambda) |
|   |   processed/YYYYMMDD/file.docx.txt   <-- text output     |   |
|   |   processed/YYYYMMDD/file.docx.json  <-- JSON output     |   |
|   +----------------------------------------------------------+   |
|                          |                                       |
|                   S3 VPC Endpoint (free)                         |
+------------------------------------------------------------------+
```

## Prerequisites

- AWS CLI configured with credentials
- Node.js 24+
- CDK bootstrapped in target account/region: `cd infra && npx cdk bootstrap`

## Deploy

```bash
cd infra
npm install
npx cdk deploy
```

### Deploy with ECS Exec (for debugging)

```bash
npx cdk deploy --context enableExec=true
```

This enables SSM port-forwarding to the Fargate task for direct testing:

```bash
aws ssm start-session \
  --target "ecs:CLUSTER_TASK_RUNTIMEID" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["5000"],"localPortNumber":["15000"]}' \
  --region us-west-2
```

## Usage

### Local Web UI

A drag-and-drop interface powered by [Portless](https://portless.sh/) for a stable named URL:

```bash
cd ui
npm install
npm start
# -> https://liteparse.localhost
```

Drag and drop any supported file. The UI uploads to S3, waits for the Lambda to parse it, then shows the extracted text inline with download buttons for `.txt` and `.json`.

For hot-reload during development:
```bash
npm run dev
```

### Direct API (from within VPC)

```bash
# Parse and get text
curl -X POST "http://<ALB_DNS>/parse?text=true" -F "file=@document.docx"

# Parse and get JSON with page structure
curl -X POST "http://<ALB_DNS>/parse" -F "file=@document.pdf"

# Screenshot pages
curl -X POST "http://<ALB_DNS>/screenshots?pages=1,2" -F "file=@document.pdf"
```

### Event-driven (S3 pipeline)

```bash
# Upload a document — Lambda triggers automatically
aws s3 cp report.docx s3://liteparse-docs-ACCOUNT_ID/raw/20260523/report.docx

# Results appear within seconds
aws s3 ls s3://liteparse-docs-ACCOUNT_ID/processed/20260523/
# → report.docx.txt
# → report.docx.json
```

## Stack Outputs

| Output | Description |
|--------|-------------|
| `ServiceUrl` | Internal ALB endpoint for direct API calls |
| `BucketName` | S3 bucket name (`liteparse-docs-{account-id}`) |
| `ParseFunctionName` | Lambda function name for the S3 pipeline |
| `ParseFunctionArn` | Lambda function ARN |

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--context enableExec=true` | `false` | Enable ECS Exec/SSM for debugging |
| `LITEPARSE_BUCKET` env var | `liteparse-docs-{account-id}` | Override S3 bucket for the local UI |

## Infrastructure Details

- **ECS**: 1 vCPU, 4 GB RAM, auto-scales 1–4 tasks at 70% CPU
- **Lambda**: Node.js 24, ARM64, 512 MB, 5-min timeout
- **S3**: Versioned, Standard-IA after 30 days, 90-day expiry, multi-AZ
- **Networking**: Internal ALB, S3 VPC Gateway endpoint, 1 NAT gateway
- **Monitoring**: CloudWatch alarms on 5xx rate, CPU, unhealthy hosts
- **Deployment safety**: Circuit breaker with rollback, 100% min healthy

## Supported Formats

- PDF, DOCX, XLSX, PPTX
- PNG, JPG (with OCR via Tesseract.js)

## Cost Estimate

| Component | Approx. Monthly |
|-----------|----------------|
| Fargate (1 task, 1 vCPU/4GB) | ~$30 |
| NAT Gateway + data | ~$30 |
| ALB | ~$16 |
| Lambda | < $1 (pay per invocation) |
| S3 | < $1 |
| **Total** | **~$77/month at idle** |

> NAT cost can be reduced with a VPC endpoint for GHCR (future consideration).

## Project Structure

```
├── infra/
│   ├── bin/infra.ts              # CDK app entry point
│   ├── lib/infra-stack.ts        # Main stack definition
│   ├── lib/lambda/
│   │   └── parse-handler.ts      # S3 event → parse → write results
│   └── test/infra.test.ts        # Infrastructure tests (TODO)
├── ui/
│   ├── server.ts             # Local Express server (S3 upload, poll, preview)
│   ├── public/
│   │   └── index.html        # Drag-and-drop frontend
│   └── package.json
├── docs/
│   ├── architecture-decisions.md # Full design rationale
│   ├── hosting-liteparse-on-ecs.md
│   └── liteparse-overview.md
├── CHANGELOG.md
└── PROGRESS_LOG.md
```

## Related Docs

- [Architecture Decisions](docs/architecture-decisions.md)
- [LiteParse Overview](docs/liteparse-overview.md)
- [LiteParse Server API](https://developers.llamaindex.ai/liteparse/guides/server-usage/#api-specification)
