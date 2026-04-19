import { loadConfig, resolveConfigPath } from './config/loader.js';
import { ConfigWatcher } from './config/watcher.js';
import { reloadConfigFromDisk } from './config/reload.js';
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

// Shared reload context — the POST /config/reload handler and the
// fs-watching ConfigWatcher both mutate `monitor` via this ref so the
// two paths stay coherent.
const monitorRef = { current: monitor };

// Start server with a hot-reload callback bound to the current
// kubeconfig path (when resolvable). When the path isn't known
// (stdin/inline config), the endpoint returns 503 unavailable.
const server = createServer(config, registry, {
  ...(resolvedConfigPath
    ? {
        onReload: () =>
          reloadConfigFromDisk({
            configPath: resolvedConfigPath,
            config,
            registry,
            monitorRef,
          }),
      }
    : {}),
});
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
  watcher = new ConfigWatcher(resolvedConfigPath, () => {
    // Both the watcher + HTTP endpoint go through the same helper so
    // a reload via fs.watch behaves identically to a POST /config/reload.
    reloadConfigFromDisk({
      configPath: resolvedConfigPath,
      config,
      registry,
      monitorRef,
    });
  });
  watcher.start();
}

// Graceful shutdown
process.on('SIGINT', () => {
  log.info('shutting down (SIGINT)');
  watcher?.stop();
  monitorRef.current.stop();
  server.stop();
});

process.on('SIGTERM', () => {
  log.info('shutting down (SIGTERM)');
  watcher?.stop();
  monitorRef.current.stop();
  server.stop();
});
