# Changelog

## [0.4.0] - 2026-05-23

### Added
- [UI] Local drag-and-drop web UI for uploading documents and downloading parsed results
- [UI] Express server with S3 upload, polling, preview, and download APIs
- [UI] Dark editorial design with JetBrains Mono + Outfit fonts, smooth animations
- [UI] Text/JSON tab switcher and inline preview of parsed output
- [UI] Portless integration for stable named URL (https://liteparse.localhost)
- [INFRA] Lambda runtime upgraded from Node.js 22 to Node.js 24

## [0.3.0] - 2026-05-23

### Added
- [INFRA] Lambda function (Node.js 22, ARM64) for S3 event-driven parsing pipeline
- [INFRA] S3 event notification: `raw/` prefix → Lambda → ECS → `processed/` (.txt + .json)
- [INFRA] S3 VPC Gateway endpoint (free, avoids NAT data transfer charges)
- [INFRA] Auto-scaling: 1–4 tasks, target-tracking on CPU utilization at 70%
- [INFRA] CloudWatch alarms: ALB 5xx rate, CPU >85% sustained, unhealthy host count
- [INFRA] S3 bucket versioning enabled

### Changed
- [FIX] S3 bucket now uses explicit name `liteparse-docs-{account-id}` (was CDK auto-generated, creating duplicates on every deploy)
- [FIX] Health check narrowed from `200-404` to `200,404` (excludes 400-403 range)
- [FIX] Storage class changed from ONE_ZONE_INFREQUENT_ACCESS to INFREQUENT_ACCESS (multi-AZ, consistent with RETAIN policy)
- [INFRA] ECS Exec gated behind CDK context `--context enableExec=true` (off by default)
- [DOCS] Architecture doc corrected: X86_64 (not ARM64 — upstream image has no ARM variant)
- [DOCS] Architecture doc updated with scaling, alarms, VPC endpoint, Lambda pipeline

### Fixed
- [BUG] Duplicate S3 buckets on every stack deploy due to missing explicit bucket name

## [0.2.0] - 2026-05-22

### Changed
- [BREAKING] Pivoted from Lambda to ECS Fargate
- [INFRA] Replaced custom Dockerfile + handler.js with pre-built ghcr.io/run-llama/liteparse-server:main
- [INFRA] CDK stack now creates VPC, ECS cluster, Fargate service, internal ALB
- [INFRA] Callers POST files directly to /parse (no S3 intermediate for hot path)
- [DOCS] Updated architecture-decisions.md with ECS approach and native LiteParse API

### Removed
- [INFRA] Custom Dockerfile (AL2023 + LibreOffice) — LibreOffice not in AL2023 repos
- [INFRA] handler.js Lambda wrapper — no longer needed
- [INFRA] Lambda Function URL — replaced by internal ALB

### Retained
- [INFRA] S3 bucket with raw/processed structure, lifecycle rules
- [DECISION] CDK TypeScript
- [DECISION] 90-day lifecycle expiry
- [DECISION] Date-partitioned folder structure (YYYYMMDD)

## [0.1.0] - 2026-05-22

### Added
- [INFRA] Initial CDK stack with Lambda DockerImageFunction (abandoned)
- [DOCS] architecture-decisions.md
- [DOCS] liteparse-overview.md
- [DOCS] hosting-liteparse-on-ecs.md

### Decisions Made
- [DECISION] ARM64 Graviton — cheaper, native builds on Apple Silicon
- [DECISION] S3 as storage layer — raw/YYYYMMDD/ and processed/YYYYMMDD/
- [DECISION] Output naming: processed/YYYYMMDD/filename.ext.txt or .json
- [DECISION] One Zone-IA storage, 90-day lifecycle expiry
- [DECISION] format field is array — supports ["text"], ["json"], or both
- [DECISION] CDK TypeScript for IaC
