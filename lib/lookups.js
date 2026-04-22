'use strict';

const { API_VERSION, sleep } = require('./http');

const PRODUCT2_BATCH_SIZE = 200;
const SOQL_PACE_MS = 100;

function escapeSoqlValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function queryAll(client, soql) {
  const out = [];
  let url = `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  while (url) {
    const res = await client.get(url);
    out.push(...(res.records || []));
    url = res.nextRecordsUrl || null;
  }
  return out;
}

async function fetchElectronicMediaGroups(client) {
  const soql =
    `SELECT Id, DeveloperName FROM ElectronicMediaGroup ` +
    `WHERE DeveloperName IN ('productDetailImage', 'productListImage', 'productSearchImage')`;
  const records = await queryAll(client, soql);
  const map = new Map();
  for (const r of records) map.set(r.DeveloperName, r.Id);
  return map;
}

async function fetchProductIdsBySku(client, skus, paceMs = SOQL_PACE_MS) {
  const unique = Array.from(new Set(skus.filter((s) => s && s.trim() !== '')));
  const map = new Map();

  for (let i = 0; i < unique.length; i += PRODUCT2_BATCH_SIZE) {
    const chunk = unique.slice(i, i + PRODUCT2_BATCH_SIZE);
    const inList = chunk.map((s) => `'${escapeSoqlValue(s)}'`).join(',');
    const soql = `SELECT Id, StockKeepingUnit FROM Product2 WHERE StockKeepingUnit IN (${inList})`;
    const records = await queryAll(client, soql);
    for (const r of records) {
      if (r.StockKeepingUnit) map.set(r.StockKeepingUnit, r.Id);
    }
    if (paceMs > 0 && i + PRODUCT2_BATCH_SIZE < unique.length) await sleep(paceMs);
  }

  return map;
}

module.exports = { fetchElectronicMediaGroups, fetchProductIdsBySku, queryAll };
