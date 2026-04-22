'use strict';

const fs = require('fs');
const { parse } = require('csv-parse');

const VALID_IMAGE_TYPES = new Set(['productListImage', 'productDetailImage', 'productSearchImage']);

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
  return cleaned || 'img';
}

function buildNames(slug) {
  const urlName = `product-img-${slug}`.slice(0, 80);
  let apiName = `product_img_${slug}`.replace(/-/g, '_').replace(/[^a-z0-9_]/gi, '_');
  apiName = apiName.replace(/_+/g, '_').replace(/_+$/, '').slice(0, 80);
  return { urlName, apiName };
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
    if (!VALID_IMAGE_TYPES.has(imageType)) {
      rows.push({ rowNum, title, url, sku, imageType, skipReason: `unknown imageType "${imageType}"` });
      continue;
    }

    if (!uniqueByUrl.has(url)) {
      const slug = urlSlug(url);
      const { urlName, apiName } = buildNames(slug);
      uniqueByUrl.set(url, {
        url,
        title: title || `${sku}-Image`,
        sku,
        urlName,
        apiName,
        managedContentId: null,
        firstRow: rowNum,
      });
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

module.exports = { loadCsv, urlSlug, buildNames, VALID_IMAGE_TYPES };
