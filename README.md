# Salesforce CMS URL Import

Node.js CLI that imports product media URLs (images and document attachments) into Salesforce CMS as external references and links them to `Product2` records via `ProductMedia`. Reuses an existing SF CLI session for authentication — no Connected App required.

## Prerequisites

- Node.js 18+
- SF CLI installed and authenticated to the target org: `sf org login web --alias <name>`
- Trusted URL configured in the target org for each external hosting domain:
  - For images: `img-src` directive (e.g. `images.salsify.com`)
  - For attachments (PDFs, Office docs): `default-src` directive on the attachment host
- Enhanced CMS Workspace ID for the target org
- For attachments: an `ElectronicMediaGroup` with `DeveloperName = 'attachment'` must exist in the target org

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
| `--csv`        | Yes      | Path to the input CSV (`title, url, SKU, imageType`). See [CSV format](#csv-format) below. |
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

## CSV format

Single CSV may mix images and attachments. Columns: `title, url, SKU, imageType`.

`imageType` accepts:

| Value | Kind | CMS content type |
|-------|------|-------------------|
| `productListImage` | image | `sfdc_cms__image` |
| `productDetailImage` | image | `sfdc_cms__image` |
| `productSearchImage` | image | `sfdc_cms__image` |
| `attachment` | attachment | `sfdc_cms__document` |

Attachment URLs must end in a supported file extension. MIME type is derived from the extension:

| Extension | MIME type |
|-----------|-----------|
| `.pdf` | `application/pdf` |
| `.doc` | `application/msword` |
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `.xls` | `application/vnd.ms-excel` |
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `.ppt` | `application/vnd.ms-powerpoint` |
| `.pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |

Rows with an unsupported attachment extension are skipped and logged in the error CSV.

`title` is optional; defaults to `${SKU}-Image` for images and `${SKU}-Attachment` for attachments.

## Phases

1. **Create CMS content** — Connect Batch API, 25 items per batch. Creates one CMS item per unique URL (`sfdc_cms__image` for image rows, `sfdc_cms__document` for attachment rows).
2. **Publish** — Connect publish endpoint. Moves Phase 1 content from Draft to Published.
3. **ProductMedia** — Composite sObjects API, 200 records per batch. One row per CSV input row, joining SKU → Product2.Id, URL → managedContentId, and `imageType` → ElectronicMediaGroup.

Each phase can be run independently with `--phase N`.

## Outputs

- `checkpoint-<orgAlias>.json` — written after each batch; allows resume after Ctrl+C / failure.
- `errors-<orgAlias>-<timestamp>.csv` — per-row failures across all phases.

## Windows PowerShell

Same commands. Requires Node 18+.
