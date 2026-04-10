import type {
  RequestClassification,
  RoutingProfile,
  RoutingPolicy,
  ExecutionPlan,
  PlanStage,
  Capability,
  NodeDefinition,
} from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';

let planCounter = 0;

function generatePlanId(): string {
  return `plan-${Date.now()}-${++planCounter}`;
}

/** Select the best node for a capability given profile constraints */
function selectNode(
  registry: NodeRegistry,
  capability: Capability,
  profile: RoutingProfile,
  policy: RoutingPolicy,
  excludeNodeIds?: Set<string>,
): NodeDefinition | null {
  let candidates = registry.findByCapabilities([capability]);

  // Exclude specific nodes (used during dynamic re-routing)
  if (excludeNodeIds?.size) {
    candidates = candidates.filter((n) => !excludeNodeIds.has(n.id));
  }

  candidates = registry.filterByTags(candidates, profile.requiredTags, profile.excludedTags);

  if (policy.requireHealthy) {
    candidates = registry.filterByHealth(candidates, profile.allowDegradedNodes);
  }

  candidates = registry.sortByPriority(candidates);

  candidates = registry.applyProfileConstraints(candidates, profile);

  return candidates[0] ?? null;
}

export interface PlanError {
  type: 'no-nodes' | 'capability-gap';
  capability: Capability;
  message: string;
}

export type PlanResult =
  | { ok: true; plan: ExecutionPlan }
  | { ok: false; error: PlanError };

/** Build an execution plan from a classified request */
export function buildPlan(
  classification: RequestClassification,
  profile: RoutingProfile,
  policy: RoutingPolicy,
  registry: NodeRegistry,
  excludeNodeIds?: Set<string>,
): PlanResult {
  const stages: PlanStage[] = [];
  const suggestedStages = classification.suggestedStages;

  // Apply maxStages constraint from profile
  const maxStages = profile.maxStages ?? suggestedStages.length;
  const effectiveStages = suggestedStages.slice(-maxStages); // keep last N stages (always keep reasoning)

  // Validate that truncation did not drop required capabilities
  const plannedCapabilities = new Set(effectiveStages.flat());
  const missingCapabilities = classification.requiredCapabilities.filter(
    (cap) => !plannedCapabilities.has(cap),
  );
  if (missingCapabilities.length > 0) {
    return {
      ok: false,
      error: {
        type: 'capability-gap',
        capability: missingCapabilities[0],
        message: `Profile "${profile.id}" (maxStages=${maxStages}) cannot satisfy required capabilities: ${missingCapabilities.join(', ')}`,
      },
    };
  }

  for (let i = 0; i < effectiveStages.length; i++) {
    const stageCapabilities = effectiveStages[i];
    const primaryCapability = stageCapabilities[0];

    const node = selectNode(registry, primaryCapability, profile, policy, excludeNodeIds);

    if (!node) {
      return {
        ok: false,
        error: {
          type: 'no-nodes',
          capability: primaryCapability,
          message: `No healthy node available for capability "${primaryCapability}" with profile "${profile.id}"`,
        },
      };
    }

    const isLast = i === effectiveStages.length - 1;

    stages.push({
      stageIndex: i,
      capability: primaryCapability,
      nodeId: node.id,
      nodeLabel: node.label,
      inputType: i === 0 ? 'original' : 'evidence',
      description: isLast && stages.length > 0
        ? `Synthesize with ${node.label} (${primaryCapability})`
        : `Process with ${node.label} (${primaryCapability})`,
    });
  }

  const requiresSynthesis =
    stages.length > 1 || (profile.synthesisRequired ?? false);

  return {
    ok: true,
    plan: {
      id: generatePlanId(),
      profileId: profile.id,
      stages,
      requiresSynthesis,
      classification,
      createdAt: Date.now(),
    },
  };
}
