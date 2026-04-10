import { loadConfig, resolveConfigPath } from './config/loader.js';
import { ConfigWatcher } from './config/watcher.js';
import { NodeRegistry } from './registry/registry.js';
import { HealthMonitor } from './health/monitor.js';
import { createServer } from './api/server.js';
import { log, setLogLevel } from './logger/index.js';
import type { LogLevel } from './logger/index.js';

const configPath = process.argv[2];

// Load config and track which file was resolved
const resolvedConfigPath = resolveConfigPath(configPath);
const config = loadConfig(configPath);

// Set log level from config or env
const logLevel = (process.env.EMBERSYNTH_LOG_LEVEL ?? config.server.logLevel ?? 'info') as LogLevel;
setLogLevel(logLevel);

log.info('config loaded', {
  nodes: config.nodes.length,
  profiles: config.profiles.length,
  syntheticModels: Object.keys(config.syntheticModels),
});

// Initialize registry
const registry = new NodeRegistry();
registry.load(config.nodes);

// Start health monitor
let monitor = new HealthMonitor(config, registry);
monitor.start();

// Start server
let server = createServer(config, registry);
log.info('server started', {
  host: config.server.host,
  port: config.server.port,
  url: `http://${config.server.host}:${config.server.port}`,
  models: Object.keys(config.syntheticModels),
});

// Optional config hot-reload
let watcher: ConfigWatcher | null = null;
const watchEnabled = process.env.EMBERSYNTH_WATCH === 'true' || config.server.watch === true;
if (watchEnabled && resolvedConfigPath) {
  watcher = new ConfigWatcher(resolvedConfigPath, (newConfig) => {
    const oldNodes = [...registry.getAll()];
    const healthSnapshot = registry.snapshotHealth();
    try {
      registry.load(newConfig.nodes);
      Object.assign(config, newConfig);
      const newMonitor = new HealthMonitor(newConfig, registry);
      
      // Success — swap monitor state
      monitor.stop();
      monitor = newMonitor;
      monitor.start();
      
      log.info('config reloaded successfully', {
        nodes: newConfig.nodes.length,
        profiles: newConfig.profiles.length,
      });
    } catch (err) {
      registry.load(oldNodes);
      registry.restoreHealth(healthSnapshot);
      log.error('config reload failed, keeping current config', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
  watcher.start();
}

// Graceful shutdown
process.on('SIGINT', () => {
  log.info('shutting down (SIGINT)');
  watcher?.stop();
  monitor.stop();
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log.info('shutting down (SIGTERM)');
  watcher?.stop();
  monitor.stop();
  server.stop();
  process.exit(0);
});
