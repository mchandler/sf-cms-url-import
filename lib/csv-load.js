'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { parse } = require('csv-parse');

const PRODUCT_IMAGE_TYPES = new Set(['productListImage', 'productDetailImage', 'productSearchImage']);
const PRODUCT_ATTACHMENT_TYPES = new Set(['attachment']);
const CATEGORY_IMAGE_TYPES = new Set(['bannerImage', 'tileImage']);

const VALID_TYPES_BY_KIND = {
  product: new Set([...PRODUCT_IMAGE_TYPES, ...PRODUCT_ATTACHMENT_TYPES]),
  category: new Set([...CATEGORY_IMAGE_TYPES]),
};

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

function buildNames(slug, mediaKind, importKind) {
  let prefixDash;
  let prefixUnderscore;
  if (mediaKind === 'attachment') {
    prefixDash = 'product-attach-';
    prefixUnderscore = 'product_attach_';
  } else if (importKind === 'category') {
    prefixDash = 'category-img-';
    prefixUnderscore = 'category_img_';
  } else {
    prefixDash = 'product-img-';
    prefixUnderscore = 'product_img_';
  }
  const urlName = `${prefixDash}${slug}`.slice(0, 80);
  let apiName = `${prefixUnderscore}${slug}`.replace(/-/g, '_').replace(/[^a-z0-9_]/gi, '_');
  apiName = apiName.replace(/_+/g, '_').replace(/_+$/, '').slice(0, 80);
  return { urlName, apiName };
}

function mediaKindFor(imageType) {
  if (PRODUCT_ATTACHMENT_TYPES.has(imageType)) return 'attachment';
  if (PRODUCT_IMAGE_TYPES.has(imageType) || CATEGORY_IMAGE_TYPES.has(imageType)) return 'image';
  return null;
}

function readParentKey(record, importKind) {
  if (importKind === 'category') {
    return (record.categoryCode || record.CategoryCode || '').trim();
  }
  return (record.SKU || record.sku || '').trim();
}

async function loadCsv(csvPath, opts = {}) {
  const importKind = opts.kind || 'product';
  const validTypes = VALID_TYPES_BY_KIND[importKind];
  if (!validTypes) {
    throw new Error(`loadCsv: unknown kind "${importKind}"`);
  }

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
    const parentKey = readParentKey(record, importKind);
    const imageType = (record.imageType || '').trim();

    if (!url || !parentKey || !imageType) {
      rows.push({ rowNum, title, url, parentKey, imageType, skipReason: 'missing required field' });
      continue;
    }
    if (!validTypes.has(imageType)) {
      const allowed = Array.from(validTypes).join(', ');
      rows.push({
        rowNum, title, url, parentKey, imageType,
        skipReason: `unknown imageType "${imageType}" for kind=${importKind} (allowed: ${allowed})`,
      });
      continue;
    }

    const mediaKind = mediaKindFor(imageType);

    let mimeType = null;
    if (mediaKind === 'attachment') {
      const ext = urlExtension(url);
      mimeType = ATTACHMENT_MIME_BY_EXT[ext] || null;
      if (!mimeType) {
        rows.push({
          rowNum, title, url, parentKey, imageType,
          skipReason: `unsupported attachment extension ".${ext}" (supported: ${Object.keys(ATTACHMENT_MIME_BY_EXT).join(', ')})`,
        });
        continue;
      }
    }

    if (!uniqueByUrl.has(url)) {
      const slug = urlSlug(url);
      const { urlName, apiName } = buildNames(slug, mediaKind, importKind);
      const defaultTitle = mediaKind === 'attachment' ? `${parentKey}-Attachment` : `${parentKey}-Image`;
      uniqueByUrl.set(url, {
        url,
        title: title || defaultTitle,
        parentKey,
        kind: mediaKind,
        mimeType,
        urlName,
        apiName,
        managedContentId: null,
        firstRow: rowNum,
      });
    } else {
      const existing = uniqueByUrl.get(url);
      if (existing.kind !== mediaKind) {
        rows.push({
          rowNum, title, url, parentKey, imageType,
          skipReason: `URL kind conflict: previously seen as ${existing.kind} (row ${existing.firstRow}), now ${mediaKind}`,
        });
        continue;
      }
    }

    rows.push({ rowNum, title, url, parentKey, imageType, skipReason: null });
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
  mediaKindFor,
  VALID_TYPES_BY_KIND,
  PRODUCT_IMAGE_TYPES,
  PRODUCT_ATTACHMENT_TYPES,
  CATEGORY_IMAGE_TYPES,
  ATTACHMENT_MIME_BY_EXT,
};
