'use strict';

const fs = require('fs');
const path = require('path');

const USAGE = `Usage:
  node import-images.js --org <alias> --workspace <workspaceId> --csv <path> [options]
  node import-images.js --config <config.json> [options]

Options:
  --org <alias>          SF CLI org alias (required unless in config)
  --workspace <id>       Enhanced CMS Workspace ID (required unless in config)
  --csv <path>           Path to input CSV (required unless in config)
  --phase <1|2|3>        Run a single phase only (default: all)
  --force                Re-run phases that already completed
  --pace <ms>            Milliseconds between batches (default: 300)
  --batch-size <n>       Items per CMS batch request, max 25 (default: 25)
  --config <path>        JSON config file (alternative to flags above)
`;

function fail(msg) {
  console.error(msg);
  console.error('');
  console.error(USAGE);
  process.exit(1);
}

function takeValue(argv, i, flag) {
  const v = argv[i + 1];
  if (v == null || v.startsWith('--')) fail(`${flag} requires a value`);
  return v;
}

function parseArgs(argv) {
  const out = {
    configPath: null,
    org: null,
    workspaceId: null,
    csvPath: null,
    phase: null,
    force: false,
    paceMs: null,
    batchSize: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--config':      out.configPath = takeValue(argv, i++, a); break;
      case '--org':         out.org = takeValue(argv, i++, a); break;
      case '--workspace':   out.workspaceId = takeValue(argv, i++, a); break;
      case '--csv':         out.csvPath = takeValue(argv, i++, a); break;
      case '--phase':       out.phase = parseInt(takeValue(argv, i++, a), 10); break;
      case '--force':       out.force = true; break;
      case '--pace':        out.paceMs = parseInt(takeValue(argv, i++, a), 10); break;
      case '--batch-size':  out.batchSize = parseInt(takeValue(argv, i++, a), 10); break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
      default:
        fail(`Unknown argument: ${a}`);
    }
  }

  return out;
}

function loadConfigFile(configPath) {
  const abs = path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(abs)) fail(`Config file not found: ${abs}`);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    fail(`Could not read config: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`Config is not valid JSON: ${e.message}`);
  }
}

function resolveConfig(argv) {
  const cli = parseArgs(argv);
  let fromFile = {};
  if (cli.configPath) fromFile = loadConfigFile(cli.configPath);

  const cfg = {
    org: cli.org ?? fromFile.org ?? null,
    workspaceId: cli.workspaceId ?? fromFile.workspaceId ?? null,
    csvPath: cli.csvPath ?? fromFile.csvPath ?? null,
    phase: cli.phase ?? fromFile.phase ?? null,
    force: cli.force || !!fromFile.force,
    paceMs: cli.paceMs ?? fromFile.paceMs ?? 300,
    batchSize: cli.batchSize ?? fromFile.batchSize ?? 25,
  };

  if (!cfg.org) fail('Missing --org (or "org" in config)');
  if (!cfg.workspaceId) fail('Missing --workspace (or "workspaceId" in config)');
  if (!cfg.csvPath) fail('Missing --csv (or "csvPath" in config)');

  if (cfg.phase != null && ![1, 2, 3].includes(cfg.phase)) {
    fail(`--phase must be 1, 2, or 3 (got ${cfg.phase})`);
  }
  if (!Number.isInteger(cfg.paceMs) || cfg.paceMs < 0) fail('--pace must be a non-negative integer');
  if (!Number.isInteger(cfg.batchSize) || cfg.batchSize < 1 || cfg.batchSize > 25) {
    fail('--batch-size must be between 1 and 25');
  }

  cfg.csvPath = path.resolve(process.cwd(), cfg.csvPath);
  if (!fs.existsSync(cfg.csvPath)) fail(`CSV file not found: ${cfg.csvPath}`);

  return cfg;
}

module.exports = { resolveConfig, USAGE };
