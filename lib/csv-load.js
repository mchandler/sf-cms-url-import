'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { parse } = require('csv-parse');

const IMAGE_CONTENT_TYPES = new Set(['productListImage', 'productDetailImage', 'productSearchImage']);
const ATTACHMENT_CONTENT_TYPES = new Set(['attachment']);
const VALID_CONTENT_TYPES = new Set([...IMAGE_CONTENT_TYPES, ...ATTACHMENT_CONTENT_TYPES]);

const ATTACHMENT_MIME_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function urlExtension(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch (_) {
    pathname = url;
  }
  const last = pathname.split('/').filter(Boolean).pop() || '';
  const m = last.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

function urlSlug(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch (_) {
    pathname = url;
  }
  const last = pathname.split('/').filter(Boolean).pop() || '';
  const noExt = last.replace(/\.[a-z0-9]+$/i, '');
  const cleaned = noExt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const fragment = (cleaned || 'item').slice(0, 40);
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 8);
  return `${fragment}-${hash}`;
}

function buildNames(slug, kind) {
  const prefixDash = kind === 'attachment' ? 'product-attach-' : 'product-img-';
  const prefixUnderscore = kind === 'attachment' ? 'product_attach_' : 'product_img_';
  const urlName = `${prefixDash}${slug}`.slice(0, 80);
  let apiName = `${prefixUnderscore}${slug}`.replace(/-/g, '_').replace(/[^a-z0-9_]/gi, '_');
  apiName = apiName.replace(/_+/g, '_').replace(/_+$/, '').slice(0, 80);
  return { urlName, apiName };
}

function kindFor(imageType) {
  if (ATTACHMENT_CONTENT_TYPES.has(imageType)) return 'attachment';
  if (IMAGE_CONTENT_TYPES.has(imageType)) return 'image';
  return null;
}

async function loadCsv(csvPath) {
  const uniqueByUrl = new Map();
  const rows = [];

  const parser = fs.createReadStream(csvPath).pipe(
    parse({
      bom: true,
      columns: true,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    })
  );

  let rowNum = 1;
  for await (const record of parser) {
    rowNum++;
    const title = (record.title || '').trim();
    const url = (record.url || '').trim();
    const sku = (record.SKU || record.sku || '').trim();
    const imageType = (record.imageType || '').trim();

    if (!url || !sku || !imageType) {
      rows.push({ rowNum, title, url, sku, imageType, skipReason: 'missing required field' });
      continue;
    }
    if (!VALID_CONTENT_TYPES.has(imageType)) {
      rows.push({ rowNum, title, url, sku, imageType, skipReason: `unknown imageType "${imageType}"` });
      continue;
    }

    const kind = kindFor(imageType);

    let mimeType = null;
    if (kind === 'attachment') {
      const ext = urlExtension(url);
      mimeType = ATTACHMENT_MIME_BY_EXT[ext] || null;
      if (!mimeType) {
        rows.push({
          rowNum, title, url, sku, imageType,
          skipReason: `unsupported attachment extension ".${ext}" (supported: ${Object.keys(ATTACHMENT_MIME_BY_EXT).join(', ')})`,
        });
        continue;
      }
    }

    if (!uniqueByUrl.has(url)) {
      const slug = urlSlug(url);
      const { urlName, apiName } = buildNames(slug, kind);
      const defaultTitle = kind === 'attachment' ? `${sku}-Attachment` : `${sku}-Image`;
      uniqueByUrl.set(url, {
        url,
        title: title || defaultTitle,
        sku,
        kind,
        mimeType,
        urlName,
        apiName,
        managedContentId: null,
        firstRow: rowNum,
      });
    } else {
      const existing = uniqueByUrl.get(url);
      if (existing.kind !== kind) {
        rows.push({
          rowNum, title, url, sku, imageType,
          skipReason: `URL kind conflict: previously seen as ${existing.kind} (row ${existing.firstRow}), now ${kind}`,
        });
        continue;
      }
    }

    rows.push({ rowNum, title, url, sku, imageType, skipReason: null });
  }

  const uniqueImages = Array.from(uniqueByUrl.values());

  return {
    uniqueImages,
    uniqueByUrl,
    rows,
    stats: {
      totalRows: rowNum - 1,
      uniqueUrls: uniqueImages.length,
      skipped: rows.filter((r) => r.skipReason).length,
    },
  };
}

module.exports = {
  loadCsv,
  urlSlug,
  buildNames,
  urlExtension,
  kindFor,
  VALID_CONTENT_TYPES,
  IMAGE_CONTENT_TYPES,
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_MIME_BY_EXT,
};
