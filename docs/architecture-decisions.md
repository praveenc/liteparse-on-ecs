# LiteParse on AWS - Architecture Decisions

## Compute: ECS Fargate (revised from Lambda)

- **Decision**: ECS Fargate running the pre-built `ghcr.io/run-llama/liteparse-server:main` image
- **Original plan**: Lambda with custom container. Abandoned because LibreOffice is not available in AL2023 repos, and the pre-built LiteParse server image already bundles all deps and exposes an HTTP API.
- **Rationale**: Zero custom Dockerfile. The pre-built image runs an HTTP server on port 5000 with `POST /parse` and `POST /screenshots` endpoints. ECS Fargate is the natural fit for a long-running HTTP container.
- **Configuration**:
  - CPU: 1024 (1 vCPU)
  - Memory: 4096 MB
  - Architecture: X86_64 (upstream image does not publish ARM64)
  - Desired count: 1 (single task for low usage)
  - Circuit breaker enabled with rollback

## Container Image

- **Image**: `ghcr.io/run-llama/liteparse-server:main` (pre-built, pulled from GHCR)
- **Includes**: Node.js/Bun, LibreOffice, ImageMagick, Ghostscript, Tesseract.js, LiteParse
- **No custom Dockerfile needed**

## API Interface

- **Endpoint**: Internal ALB → ECS Fargate → LiteParse server port 5000
- **Public**: No (internal ALB only, accessible within VPC)
- **Protocol**: HTTP multipart form POST (file upload directly to `/parse`)

### Native LiteParse API (used directly)

**POST /parse** - Parse a document

Form fields:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The document to parse |
| `config` | string | No | JSON-serialized LiteParseConfig (e.g., `{"ocrEnabled": true}`) |

Query parameters:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `text` | boolean | `false` | If `true`, returns `text/plain`; otherwise returns JSON with `pages` array |

Responses:
- `200 text/plain` - extracted text (when `?text=true`)
- `200 application/json` - `{ "pages": [...] }` (when `?text=false`)
- `400` - missing file
- `429` - rate limit exceeded

**POST /screenshots** - Screenshot pages

Form fields:
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The document to screenshot |
| `config` | string | No | JSON-serialized LiteParseConfig |

Query parameters:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `pages` | string | all | Comma-separated 1-based page numbers |

Response: NDJSON stream with base64 PNGs per page.

## S3 Bucket (for storage/audit)

```
s3://liteparse-docs-{account-id}/
├── raw/YYYYMMDD/report.docx            <- input files (optional archival)
├── processed/YYYYMMDD/report.docx.txt  <- text output (optional caching)
└── processed/YYYYMMDD/report.docx.json <- json output (optional caching)
```

- S3 is optional for the hot path - callers can POST files directly to `/parse`
- S3 is available for archiving inputs and caching outputs if needed
- Date partitioning avoids staleness when same filename is uploaded on different days

## S3 Lifecycle & Storage

- **Storage class**: S3 Standard-IA (multi-AZ)
- **Versioning**: Enabled for accidental overwrite/delete recovery
- **Retention**: 90 days for both `raw/` and `processed/` prefixes
- **Adjustable**: Lifecycle rules can be updated anytime without affecting existing objects

## Event-Driven Parsing Pipeline

- **Trigger**: S3 `OBJECT_CREATED` notification on `raw/` prefix
- **Lambda**: Node.js 22 (ARM64, 512 MB, 5-min timeout) deployed in VPC private subnets
- **Flow**: Download file from S3 → POST to internal ALB `/parse` → Write `.txt` and `.json` to `processed/`
- **Security group**: Lambda allowed to reach ALB on port 80
- **IAM**: Lambda has S3 read/write grant on the docs bucket

```
S3 raw/YYYYMMDD/file.docx → S3 Notification → Lambda → POST ALB:80/parse → S3 processed/YYYYMMDD/file.docx.txt + .json
```

## Security

- Internal ALB (not internet-facing)
- Accessible only within VPC (other services/Lambdas must be in same VPC or use VPC peering/endpoints)
- ECS task role has S3 read/write access to the docs bucket
- Lambda function has S3 read/write access and VPC network access to ALB
- ECS Exec disabled by default; opt-in via `--context enableExec=true` for debugging
- No public exposure, no IAM auth on HTTP (relies on network-level isolation)

## Infrastructure as Code

- **Tool**: AWS CDK (TypeScript)
- **Stack**: Single stack covering VPC, ECS cluster, Fargate service, ALB, S3 bucket, Lambda, IAM roles
- **No custom Docker build**: Uses pre-built image from GHCR directly
- **Platform**: X86_64 (pre-built image constraint)

## Networking

- VPC with 2 AZs
- 1 NAT Gateway (for Fargate tasks to pull image from GHCR)
- S3 Gateway VPC endpoint (free, avoids NAT data transfer for S3 access)
- Internal ALB for routing to Fargate tasks

## Observability

- CloudWatch Logs (2-week retention) for ECS task output
- CloudWatch Alarms:
  - Target group 5xx error rate
  - ECS CPU utilization (>85% sustained)
  - Unhealthy host count
- ALB access logs (optional, not enabled initially)
- ECS service metrics (CPU, memory) via CloudWatch built-in
- ECS Exec available when deployed with `--context enableExec=true`

## Scaling

- Auto-scaling: 1–4 tasks, target-tracking on CPU utilization at 70%
- Circuit breaker enabled with rollback for deployment safety

## Bucket Naming

- **Name**: `liteparse-docs-{account-id}` (explicit, stable across deployments)
- **Previous**: CDK auto-generated names caused duplicate buckets on every deploy

## Future Considerations (not in scope now)

- S3 Tables for analytics on processing patterns
- Caching layer (check if processed output exists before re-parsing)
- VPC endpoint for private GHCR access (avoid NAT cost)
- Additional parameters via config: `language` (OCR hint), page ranges
- Infrastructure tests (CDK assertions for security groups, task def, bucket policy)
