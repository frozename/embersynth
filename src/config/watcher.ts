import { watch } from 'fs';
import { loadConfig } from './loader.js';
import { log } from '../logger/index.js';
import type { EmberSynthConfig } from '../types/index.js';

export class ConfigWatcher {
  private watcher: ReturnType<typeof watch> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private configPath: string;
  private onChange: (config: EmberSynthConfig) => void;
  private debounceMs: number;

  constructor(
    configPath: string,
    onChange: (config: EmberSynthConfig) => void,
    debounceMs: number = 300,
  ) {
    this.configPath = configPath;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
  }

  start(): void {
    if (this.watcher) return;

    log.info('config watcher started', { path: this.configPath, debounceMs: this.debounceMs });

    this.watcher = watch(this.configPath, (_eventType) => {
      // Clear any pending debounce
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }

      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.reload();
      }, this.debounceMs);
    });

    this.watcher.on('error', (err) => {
      log.error('config watcher error', { error: err.message });
    });
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    log.info('config watcher stopped');
  }

  private reload(): void {
    log.info('config change detected, reloading', { path: this.configPath });
    try {
      const newConfig = loadConfig(this.configPath);
      this.onChange(newConfig);
      log.info('config reloaded successfully', {
        nodes: newConfig.nodes.length,
        profiles: newConfig.profiles.length,
      });
    } catch (err) {
      log.error('config reload failed', {
        path: this.configPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
