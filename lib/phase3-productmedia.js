'use strict';

const { API_VERSION, sleep } = require('./http');
const { createProgress } = require('./progress');
const { save: saveCheckpoint } = require('./checkpoint');

const COMPOSITE_BATCH_SIZE = 200;

function assignSortOrders(eligible) {
  const order = new Map();
  for (const row of eligible) {
    const key = `${row.parentId}|${row.electronicMediaGroupId}`;
    const next = order.get(key) || 0;
    row.sortOrder = next;
    order.set(key, next + 1);
  }
}

function resolveRows({
  rows, uniqueByUrl, parentIdByKey, mediaGroupIdByName,
  parentKeyLabel, parentNotFoundCode, errorLog,
}) {
  const eligible = [];

  for (const row of rows) {
    if (row.skipReason) {
      errorLog.log({
        row: row.rowNum, parentKey: row.parentKey, title: row.title, url: row.url, imageType: row.imageType,
        phase: 3, errorCode: 'CSV_SKIP', errorMessage: row.skipReason,
      });
      continue;
    }

    const unique = uniqueByUrl.get(row.url);
    const electronicMediaId = unique && unique.managedContentId;
    if (!electronicMediaId) {
      errorLog.log({
        row: row.rowNum, parentKey: row.parentKey, title: row.title, url: row.url, imageType: row.imageType,
        phase: 3, errorCode: 'NO_CMS_CONTENT', errorMessage: 'No managedContentId for URL (Phase 1 missed)',
      });
      continue;
    }

    const parentId = parentIdByKey.get(row.parentKey);
    if (!parentId) {
      errorLog.log({
        row: row.rowNum, parentKey: row.parentKey, title: row.title, url: row.url, imageType: row.imageType,
        phase: 3, errorCode: parentNotFoundCode,
        errorMessage: `No parent record found for ${parentKeyLabel} = '${row.parentKey}'`,
      });
      continue;
    }

    const electronicMediaGroupId = mediaGroupIdByName.get(row.imageType);
    if (!electronicMediaGroupId) {
      errorLog.log({
        row: row.rowNum, parentKey: row.parentKey, title: row.title, url: row.url, imageType: row.imageType,
        phase: 3, errorCode: 'NO_MEDIA_GROUP',
        errorMessage: `No ElectronicMediaGroup with DeveloperName = '${row.imageType}'`,
      });
      continue;
    }

    eligible.push({
      rowNum: row.rowNum,
      parentKey: row.parentKey,
      title: row.title,
      url: row.url,
      imageType: row.imageType,
      parentId,
      electronicMediaId,
      electronicMediaGroupId,
      sortOrder: 0,
    });
  }

  assignSortOrders(eligible);
  return eligible;
}

function toCompositeRecord(row, sObjectType, parentFkName) {
  return {
    attributes: { type: sObjectType },
    [parentFkName]: row.parentId,
    ElectronicMediaId: row.electronicMediaId,
    ElectronicMediaGroupId: row.electronicMediaGroupId,
    SortOrder: row.sortOrder,
  };
}

async function runPhase3({
  client, state, rows, uniqueByUrl,
  parentIdByKey, mediaGroupIdByName,
  sObjectType, parentFkName, parentKeyLabel,
  paceMs, errorLog, force,
}) {
  if (!sObjectType || !parentFkName) {
    throw new Error('runPhase3 requires sObjectType and parentFkName');
  }
  const parentNotFoundCode = sObjectType === 'ProductCategoryMedia' ? 'CATEGORY_NOT_FOUND' : 'SKU_NOT_FOUND';

  const phaseState = state.phases[3];
  if (phaseState.status === 'completed' && !force) {
    console.log('[Phase 3] Already completed (checkpoint). Use --force to re-run.');
    return phaseState;
  }
  phaseState.status = 'in_progress';

  const eligible = resolveRows({
    rows, uniqueByUrl, parentIdByKey, mediaGroupIdByName,
    parentKeyLabel, parentNotFoundCode, errorLog,
  });
  if (eligible.length === 0) {
    console.log('[Phase 3] No eligible rows after resolution.');
    phaseState.status = 'completed';
    saveCheckpoint(state);
    return phaseState;
  }

  const totalBatches = Math.ceil(eligible.length / COMPOSITE_BATCH_SIZE);
  const progress = createProgress('Phase 3', totalBatches);
  console.log(
    `[Phase 3] ${eligible.length} ${sObjectType} rows across ${totalBatches} batches of ${COMPOSITE_BATCH_SIZE}`
  );

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    if (batchIndex <= phaseState.lastBatchIndex && !force) continue;

    const slice = eligible.slice(batchIndex * COMPOSITE_BATCH_SIZE, (batchIndex + 1) * COMPOSITE_BATCH_SIZE);
    const records = slice.map((r) => toCompositeRecord(r, sObjectType, parentFkName));

    let response;
    try {
      response = await client.post(`/services/data/${API_VERSION}/composite/sobjects`, {
        allOrNone: false,
        records,
      });
    } catch (e) {
      console.error(`[Phase 3] Batch ${batchIndex + 1} failed entirely: ${e.message}`);
      for (const row of slice) {
        errorLog.log({
          row: row.rowNum, parentKey: row.parentKey, title: row.title, url: row.url, imageType: row.imageType,
          phase: 3, errorCode: 'COMPOSITE_REQUEST_FAILED', errorMessage: e.message.slice(0, 500),
        });
      }
      progress.record({ fail: slice.length });
      phaseState.failed += slice.length;
      phaseState.lastBatchIndex = batchIndex;
      saveCheckpoint(state);
      progress.print(batchIndex);
      if (paceMs > 0) await sleep(paceMs);
      continue;
    }

    const results = Array.isArray(response) ? response : [];
    let okCount = 0;
    let failCount = 0;
    for (let i = 0; i < slice.length; i++) {
      const row = slice[i];
      const r = results[i];
      if (r && r.success) {
        okCount++;
      } else {
        failCount++;
        const errs = (r && r.errors) || [];
        const first = errs[0] || {};
        errorLog.log({
          row: row.rowNum, parentKey: row.parentKey, title: row.title, url: row.url, imageType: row.imageType,
          phase: 3,
          errorCode: first.statusCode || 'INSERT_FAILED',
          errorMessage: (first.message || JSON.stringify(r)).slice(0, 500),
        });
      }
    }

    progress.record({ ok: okCount, fail: failCount });
    phaseState.succeeded += okCount;
    phaseState.failed += failCount;
    phaseState.lastBatchIndex = batchIndex;
    saveCheckpoint(state);
    progress.print(batchIndex);

    if (paceMs > 0 && batchIndex + 1 < totalBatches) await sleep(paceMs);
  }

  phaseState.status = 'completed';
  saveCheckpoint(state);
  const sum = progress.summary();
  console.log(`[Phase 3] Done. Inserted: ${sum.succeeded} | Failed: ${sum.failed}`);
  return phaseState;
}

module.exports = { runPhase3, resolveRows };
