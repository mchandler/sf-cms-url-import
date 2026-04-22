#!/usr/bin/env node
'use strict';

const readline = require('readline');

const { resolveConfig } = require('./lib/args');
const { createSession } = require('./lib/auth');
const { createClient } = require('./lib/http');
const { loadCsv } = require('./lib/csv-load');
const { fetchElectronicMediaGroups, fetchProductIdsBySku } = require('./lib/lookups');
const { createErrorLog } = require('./lib/error-log');
const { formatDuration } = require('./lib/progress');
const checkpointLib = require('./lib/checkpoint');
const { runPhase1 } = require('./lib/phase1-create');
const { runPhase2 } = require('./lib/phase2-publish');
const { runPhase3 } = require('./lib/phase3-productmedia');

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function resolveCheckpoint({ cfg, freshUniqueImages }) {
  const existing = checkpointLib.load(cfg.org);
  if (!existing) {
    const state = checkpointLib.emptyState(cfg.org, cfg.csvPath, cfg.workspaceId);
    state.uniqueImages = freshUniqueImages;
    return state;
  }

  const warnings = [];
  if (existing.csvPath && existing.csvPath !== cfg.csvPath) {
    warnings.push(`  CSV path differs: checkpoint=${existing.csvPath} vs current=${cfg.csvPath}`);
  }
  if (existing.workspaceId && existing.workspaceId !== cfg.workspaceId) {
    warnings.push(`  Workspace ID differs: checkpoint=${existing.workspaceId} vs current=${cfg.workspaceId}`);
  }

  console.log(`Found checkpoint: checkpoint-${cfg.org}.json`);
  console.log(`  Timestamp: ${existing.timestamp}`);
  for (const p of [1, 2, 3]) {
    const ph = existing.phases[p] || { status: 'pending', succeeded: 0, failed: 0 };
    console.log(`  Phase ${p}: ${ph.status} (ok=${ph.succeeded}, fail=${ph.failed})`);
  }
  if (warnings.length) {
    console.log('Warnings:');
    for (const w of warnings) console.log(w);
  }

  const answer = await prompt('Resume from this checkpoint? [Y/n]: ');
  if (answer === 'n' || answer === 'no') {
    const backupPath = checkpointLib.backup(cfg.org);
    console.log(`Backed up old checkpoint to ${backupPath}`);
    return checkpointLib.emptyState(cfg.org, cfg.csvPath, cfg.workspaceId);
  }

  const existingByUrl = new Map();
  for (const e of existing.uniqueImages || []) existingByUrl.set(e.url, e);

  const mergedUniqueImages = freshUniqueImages.map((entry) => {
    const prior = existingByUrl.get(entry.url);
    if (prior && prior.managedContentId) {
      return { ...entry, managedContentId: prior.managedContentId };
    }
    return entry;
  });

  return {
    ...existing,
    csvPath: cfg.csvPath,
    workspaceId: cfg.workspaceId,
    uniqueImages: mergedUniqueImages,
  };
}

function uniqueSkusFromRows(rows) {
  const set = new Set();
  for (const r of rows) {
    if (!r.skipReason && r.sku) set.add(r.sku);
  }
  return Array.from(set);
}

function printFinalSummary(state, errorLog, elapsedMs) {
  console.log('');
  console.log('=== RESULTS ===');
  for (const p of [1, 2, 3]) {
    const ph = state.phases[p];
    const label = { 1: 'CMS Creation', 2: 'Publish', 3: 'ProductMedia' }[p];
    console.log(
      `Phase ${p} (${label}): ${ph.succeeded} succeeded | ${ph.failed} failed | status=${ph.status}`
    );
  }
  console.log('');
  if (errorLog.count > 0) {
    console.log(`Error log: ${errorLog.file} (${errorLog.count} rows)`);
  } else {
    console.log('No errors logged.');
  }
  console.log(`Checkpoint: ${checkpointLib.checkpointPath(state.orgAlias)}`);
  console.log(`Total elapsed: ${formatDuration(elapsedMs)}`);
}

async function main() {
  const start = Date.now();
  const cfg = resolveConfig(process.argv.slice(2));

  console.log(`Org: ${cfg.org}`);
  console.log(`Workspace: ${cfg.workspaceId}`);
  console.log(`CSV: ${cfg.csvPath}`);
  console.log(`Pace: ${cfg.paceMs}ms | Batch size: ${cfg.batchSize} | Phase: ${cfg.phase ?? 'all'} | Force: ${cfg.force}`);
  console.log('');

  const session = createSession(cfg.org);
  await session.get();
  console.log(`Authenticated as ${(await session.get()).username} @ ${(await session.get()).instanceUrl}`);
  console.log('');

  const client = createClient(session);

  console.log('Loading CSV...');
  const { uniqueImages, uniqueByUrl, rows, stats } = await loadCsv(cfg.csvPath);
  console.log(
    `  ${stats.totalRows} rows | ${stats.uniqueUrls} unique URLs | ${stats.skipped} skipped`
  );

  const state = await resolveCheckpoint({ cfg, freshUniqueImages: uniqueImages });

  for (const entry of state.uniqueImages) uniqueByUrl.set(entry.url, entry);

  const errorLog = createErrorLog(cfg.org);

  const runAll = cfg.phase == null;
  const shouldRun = (p) => cfg.phase == null || cfg.phase === p;

  try {
    if (shouldRun(1)) {
      await runPhase1({
        client, state, workspaceId: cfg.workspaceId,
        batchSize: cfg.batchSize, paceMs: cfg.paceMs,
        errorLog, force: cfg.force,
      });
    }

    if (shouldRun(2)) {
      await runPhase2({
        client, state,
        paceMs: cfg.paceMs, errorLog, force: cfg.force,
      });
    }

    if (shouldRun(3)) {
      console.log('Loading ElectronicMediaGroup IDs...');
      const mediaGroupIdByName = await fetchElectronicMediaGroups(client);
      console.log(`  Found ${mediaGroupIdByName.size} media groups: ${Array.from(mediaGroupIdByName.keys()).join(', ')}`);

      console.log('Loading Product2 IDs by SKU...');
      const skus = uniqueSkusFromRows(rows);
      const productIdBySku = await fetchProductIdsBySku(client, skus, cfg.paceMs);
      console.log(`  Matched ${productIdBySku.size} / ${skus.length} SKUs`);

      await runPhase3({
        client, state, rows, uniqueByUrl,
        productIdBySku, mediaGroupIdByName,
        paceMs: cfg.paceMs, errorLog, force: cfg.force,
      });
    }
  } catch (err) {
    console.error('');
    console.error('Fatal error:', err.message);
    await errorLog.close();
    printFinalSummary(state, errorLog, Date.now() - start);
    process.exit(2);
  }

  await errorLog.close();
  printFinalSummary(state, errorLog, Date.now() - start);

  const anyFailed = [1, 2, 3].some((p) => state.phases[p].failed > 0);
  process.exit(anyFailed ? 1 : 0);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(2);
});
