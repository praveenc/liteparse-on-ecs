#!/usr/bin/env bash
set -euo pipefail

# Usage: ./test-parse.sh <file-path> [text|json]
# Example: ./test-parse.sh ~/Documents/report.docx text
#          ./test-parse.sh ~/Documents/slides.pptx json

SERVICE_URL="${LITEPARSE_URL:-$(aws cloudformation describe-stacks --stack-name LiteparseStack --query "Stacks[0].Outputs[?OutputKey=='ServiceUrl'].OutputValue" --output text)}"

FILE="${1:?Usage: $0 <file-path> [text|json]}"
MODE="${2:-json}"

if [[ ! -f "$FILE" ]]; then
  echo "Error: File not found: $FILE" >&2
  exit 1
fi

echo "Parsing: $FILE"
echo "Mode:    $MODE"
echo "URL:     $SERVICE_URL"
echo "---"

if [[ "$MODE" == "text" ]]; then
  curl -s -w "\n--- HTTP %{http_code} | %{time_total}s ---\n" \
    -X POST "${SERVICE_URL}/parse?text=true" \
    -F "file=@${FILE}"
else
  curl -s -w "\n--- HTTP %{http_code} | %{time_total}s ---\n" \
    -X POST "${SERVICE_URL}/parse" \
    -F "file=@${FILE}" | python3 -m json.tool 2>/dev/null || true
fi
