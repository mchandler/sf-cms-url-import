'use strict';

const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify');

const COLUMNS = ['row', 'sku', 'title', 'url', 'imageType', 'phase', 'errorCode', 'errorMessage'];

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

function createErrorLog(orgAlias) {
  const file = path.resolve(process.cwd(), `errors-${orgAlias}-${timestampSlug()}.csv`);
  const out = fs.createWriteStream(file);
  const stringifier = stringify({ header: true, columns: COLUMNS, record_delimiter: '\n' });
  stringifier.pipe(out);

  let count = 0;
  let opened = false;

  return {
    file,
    log(entry) {
      opened = true;
      count++;
      stringifier.write({
        row: entry.row ?? '',
        sku: entry.sku ?? '',
        title: entry.title ?? '',
        url: entry.url ?? '',
        imageType: entry.imageType ?? '',
        phase: entry.phase ?? '',
        errorCode: entry.errorCode ?? '',
        errorMessage: entry.errorMessage ?? '',
      });
    },
    get count() { return count; },
    close() {
      return new Promise((resolve) => {
        stringifier.end();
        out.on('finish', () => {
          if (!opened) {
            try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
          }
          resolve();
        });
      });
    },
  };
}

module.exports = { createErrorLog };
