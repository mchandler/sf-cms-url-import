# Salesforce CMS URL Image Import

Node.js CLI that imports product image URLs into Salesforce CMS as external references and links them to `Product2` records via `ProductMedia`. Reuses an existing SF CLI session for authentication — no Connected App required.

## Prerequisites

- Node.js 18+
- SF CLI installed and authenticated to the target org: `sf org login web --alias <name>`
- Trusted URL configured in the target org for the image hosting domain (e.g. `images.salsify.com`)
- Enhanced CMS Workspace ID for the target org

## Install

```
npm install
```

## Usage

```
node import-images.js --org <alias> --workspace <workspaceId> --csv <path>
```

### Arguments

| Argument       | Required | Description |
|----------------|----------|-------------|
| `--org`        | Yes      | SF CLI org alias (e.g. `andersenstage`) |
| `--workspace`  | Yes      | Enhanced CMS Workspace ID for the target org |
| `--csv`        | Yes      | Path to the input CSV (`title, url, SKU, imageType`) |
| `--phase`      | No       | Run a single phase only: `1`, `2`, or `3` (default: all) |
| `--force`      | No       | Re-run phases that have already completed |
| `--pace`       | No       | Milliseconds between batches (default: 300) |
| `--batch-size` | No       | Items per Connect Batch sub-request, max 25 (default: 25) |
| `--config`     | No       | Path to a JSON config file (alternative to flags) |

### Config file

```json
{
  "org": "andersenstage",
  "workspaceId": "0ZuXXXXXXXXXXXXXXX",
  "csvPath": "./salsify-images.csv",
  "batchSize": 25,
  "paceMs": 300
}
```

```
node import-images.js --config andersenstage.json
```

## Phases

1. **Create CMS content** — Connect Batch API, 25 items per batch. Creates one CMS item per unique image URL.
2. **Publish** — Connect publish endpoint. Moves Phase 1 content from Draft to Published.
3. **ProductMedia** — Composite sObjects API, 200 records per batch. One row per CSV input row, joining SKU → Product2.Id and URL → managedContentId.

Each phase can be run independently with `--phase N`.

## Outputs

- `checkpoint-<orgAlias>.json` — written after each batch; allows resume after Ctrl+C / failure.
- `errors-<orgAlias>-<timestamp>.csv` — per-row failures across all phases.

## Windows PowerShell

Same commands. Requires Node 18+.
