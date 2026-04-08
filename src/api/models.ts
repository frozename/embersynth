import type { EmberSynthConfig, ModelListResponse } from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';

export function handleModels(config: EmberSynthConfig, registry: NodeRegistry): Response {
  const created = Math.floor(Date.now() / 1000);

  const models: ModelListResponse['data'] = Object.entries(config.syntheticModels).map(
    ([modelId, profileId]) => {
      const profile = config.profiles.find((p) => p.id === profileId);
      return {
        id: modelId,
        object: 'model' as const,
        created,
        owned_by: 'embersynth',
        description: profile?.description,
      };
    },
  );

  const response: ModelListResponse = {
    object: 'list',
    data: models,
  };

  return Response.json(response);
}
