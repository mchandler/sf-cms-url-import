'use strict';

const { API_VERSION, sleep } = require('./http');
const { createProgress } = require('./progress');
const { save: saveCheckpoint } = require('./checkpoint');
const { fetchExistingContentByExternalId } = require('./lookups');

function buildBatchRequest(workspaceId, entry) {
  const isAttachment = entry.kind === 'attachment';
  return {
    method: 'Post',
    url: `/${API_VERSION}/connect/cms/contents/`,
    richInput: {
      apiName: entry.apiName,
      contentSpaceOrFolderId: workspaceId,
      contentBody: {
        'sfdc_cms:media': {
          source: {
            mimeType: entry.mimeType || null,
            type: 'url',
            url: entry.url,
          },
          url: entry.url,
        },
      },
      contentType: isAttachment ? 'sfdc_cms__document' : 'sfdc_cms__image',
      externalId: entry.urlName,
      title: entry.title,
      urlName: entry.urlName,
    },
  };
}

function extractErrorMessage(result) {
  if (Array.isArray(result)) {
    const first = result[0] || {};
    const code = first.errorCode || first.statusCode || 'UNKNOWN_ERROR';
    const msg = first.message || JSON.stringify(first);
    return { code, message: msg };
  }
  if (result && typeof result === 'object') {
    const code = result.errorCode || 'UNKNOWN_ERROR';
    const msg = result.message || JSON.stringify(result);
    return { code, message: msg };
  }
  return { code: 'UNKNOWN_ERROR', message: String(result) };
}

async function runPhase1({ client, state, workspaceId, batchSize, paceMs, errorLog, force }) {
  const phaseState = state.phases[1];
  if (phaseState.status === 'completed' && !force) {
    console.log('[Phase 1] Already completed (checkpoint). Use --force to re-run.');
    return phaseState;
  }
  phaseState.status = 'in_progress';

  let pending = state.uniqueImages
    .map((entry, idx) => ({ entry, idx }))
    .filter(({ entry }) => !entry.managedContentId);

  if (pending.length === 0) {
    console.log('[Phase 1] All unique images already have managedContentId — skipping.');
    phaseState.status = 'completed';
    saveCheckpoint(state);
    return phaseState;
  }

  console.log(`[Phase 1] Checking workspace for existing content by urlName (${pending.length} candidates)...`);
  const externalIds = pending.map((p) => p.entry.urlName);
  const existing = await fetchExistingContentByExternalId(client, workspaceId, externalIds);
  let reused = 0;
  for (const p of pending) {
    const id = existing.get(p.entry.urlName);
    if (id) {
      p.entry.managedContentId = id;
      reused++;
    }
  }
  if (reused > 0) {
    console.log(`[Phase 1] Reused ${reused} existing CMS content item(s) by urlName`);
    saveCheckpoint(state);
    pending = pending.filter((p) => !p.entry.managedContentId);
  }

  if (pending.length === 0) {
    console.log('[Phase 1] Nothing to create — all items resolved via existing content.');
    phaseState.status = 'completed';
    saveCheckpoint(state);
    return phaseState;
  }

  const totalBatches = Math.ceil(pending.length / batchSize);
  const progress = createProgress('Phase 1', totalBatches);

  console.log(
    `[Phase 1] ${pending.length} unique images to create across ${totalBatches} batches of ${batchSize}`
  );

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const slice = pending.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
    const batchRequests = slice.map(({ entry }) => buildBatchRequest(workspaceId, entry));

    let response;
    try {
      response = await client.post(`/services/data/${API_VERSION}/connect/batch`, {
        batchRequests,
      });
    } catch (e) {
      console.error(`[Phase 1] Batch ${batchIndex + 1} failed entirely: ${e.message}`);
      for (const { entry } of slice) {
        errorLog.log({
          row: entry.firstRow,
          sku: entry.sku,
          title: entry.title,
          url: entry.url,
          phase: 1,
          errorCode: 'BATCH_REQUEST_FAILED',
          errorMessage: e.message.slice(0, 500),
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

    const results = (response && response.results) || [];
    let okCount = 0;
    let failCount = 0;

    for (let i = 0; i < slice.length; i++) {
      const { entry } = slice[i];
      const sub = results[i];
      if (!sub) {
        failCount++;
        errorLog.log({
          row: entry.firstRow, sku: entry.sku, title: entry.title, url: entry.url, phase: 1,
          errorCode: 'NO_SUBRESULT', errorMessage: 'Batch response missing sub-result',
        });
        continue;
      }
      const status = sub.statusCode;
      if (status >= 200 && status < 300) {
        const id = sub.result && sub.result.managedContentId;
        if (id) {
          entry.managedContentId = id;
          okCount++;
        } else {
          failCount++;
          errorLog.log({
            row: entry.firstRow, sku: entry.sku, title: entry.title, url: entry.url, phase: 1,
            errorCode: 'NO_CONTENT_ID', errorMessage: `Status ${status} but no managedContentId returned`,
          });
        }
      } else {
        failCount++;
        const { code, message } = extractErrorMessage(sub.result);
        errorLog.log({
          row: entry.firstRow, sku: entry.sku, title: entry.title, url: entry.url, phase: 1,
          errorCode: code, errorMessage: `${status}: ${message}`.slice(0, 500),
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
  console.log(
    `[Phase 1] Done. Created: ${sum.succeeded} | Failed: ${sum.failed} | Elapsed: ${formatMs(sum.elapsedMs)}`
  );
  return phaseState;
}

function formatMs(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

module.exports = { runPhase1 };
