import type { ProviderAdapter } from '../types/index.js';
import { OpenAICompatibleAdapter } from './openai-compatible.js';
import { GenericHttpAdapter } from './generic-http.js';

const adapters = new Map<string, ProviderAdapter>();

function register(adapter: ProviderAdapter): void {
  adapters.set(adapter.type, adapter);
}

// Register built-in adapters
register(new OpenAICompatibleAdapter());
register(new GenericHttpAdapter());

export function getAdapter(type: string): ProviderAdapter | undefined {
  return adapters.get(type);
}

export function registerAdapter(adapter: ProviderAdapter): void {
  register(adapter);
}
