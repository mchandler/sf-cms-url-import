# Salesforce CMS URL Import

Node.js CLI that imports media URLs (images and document attachments) into Salesforce CMS as external references and links them either to `Product2` records via `ProductMedia` or to `ProductCategory` records via `ProductCategoryMedia`. Reuses an existing SF CLI session for authentication — no Connected App required.

## Prerequisites

- Node.js 18+
- SF CLI installed and authenticated to the target org: `sf org login web --alias <name>`
- Trusted URL configured in the target org for each external hosting domain:
  - For images: `img-src` directive (e.g. `images.salsify.com`)
  - For attachments (PDFs, Office docs): `default-src` directive on the attachment host
- Enhanced CMS Workspace ID for the target org
- For attachments: an `ElectronicMediaGroup` with `DeveloperName = 'attachment'` must exist in the target org
- For category images: `ElectronicMediaGroup` records with `DeveloperName = 'bannerImage'` and `'tileImage'` must exist (Salesforce seeds these per store), and `ProductCategory.External_Id__c` must be populated for the categories you're targeting

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
| `--csv`        | Yes      | Path to the input CSV. Columns depend on `--kind`. See [CSV format](#csv-format) below. |
| `--kind`       | No       | `product` (default) or `category` — selects the import target |
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

### Product mode (`--kind product`, default)

Columns: `title, url, SKU, imageType`. May mix images and attachments.

| `imageType` | Media kind | CMS content type |
|-------------|------------|-------------------|
| `productListImage` | image | `sfdc_cms__image` |
| `productDetailImage` | image | `sfdc_cms__image` |
| `productSearchImage` | image | `sfdc_cms__image` |
| `attachment` | attachment | `sfdc_cms__document` |

### Category mode (`--kind category`)

Columns: `title, url, categoryCode, imageType`. `categoryCode` resolves to `ProductCategory.External_Id__c`.

| `imageType` | Media kind | CMS content type |
|-------------|------------|-------------------|
| `bannerImage` | image | `sfdc_cms__image` |
| `tileImage` | image | `sfdc_cms__image` |

### Attachment MIME types

Attachment URLs (product mode only) must end in a supported file extension. MIME type is derived from the extension:

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

`title` is optional; defaults to `${parentKey}-Image` for images and `${parentKey}-Attachment` for attachments (where `parentKey` is the row's SKU or categoryCode).

## Phases

1. **Create CMS content** — Connect Batch API, 25 items per batch. Creates one CMS item per unique URL (`sfdc_cms__image` for image rows, `sfdc_cms__document` for attachment rows). Identical for both kinds.
2. **Publish** — Connect publish endpoint. Moves Phase 1 content from Draft to Published. Identical for both kinds.
3. **Link media to parent** — Composite sObjects API, 200 records per batch:
   - Product mode: inserts `ProductMedia` rows joining `SKU → Product2.Id`, `URL → managedContentId`, and `imageType → ElectronicMediaGroup`.
   - Category mode: inserts `ProductCategoryMedia` rows joining `categoryCode → ProductCategory.Id` (via `External_Id__c`), `URL → managedContentId`, and `imageType → ElectronicMediaGroup`.

Each phase can be run independently with `--phase N`.

## Outputs

- `checkpoint-<orgAlias>.json` (product mode) or `checkpoint-<orgAlias>-category.json` (category mode) — written after each batch; allows resume after Ctrl+C / failure. Per-kind so product and category runs don't collide.
- `errors-<orgAlias>[-<kind>]-<timestamp>.csv` — per-row failures across all phases. The `parentKey` column holds the row's SKU (product mode) or categoryCode (category mode).

## Windows PowerShell

Same commands. Requires Node 18+.
