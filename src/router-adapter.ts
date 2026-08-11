import {
  calculateModelCost,
  DEFAULT_ROUTING_CONFIG,
  getFallbackChain,
  route as routeRequest,
  type ModelPricing,
} from "@blockrun/router-core";
import type {
  ChatCompletionOptions,
  ChatMessage,
  RoutingDecision,
  RoutingProfile,
} from "./types";

const AUTO_ROUTING_PROFILES: Readonly<Record<string, RoutingProfile>> = {
  "blockrun/auto": "auto",
  "blockrun/eco": "eco",
  "blockrun/premium": "premium",
};

export type { ModelPricing };

export function routingProfileForModel(model: string): RoutingProfile | undefined {
  return AUTO_ROUTING_PROFILES[model.toLowerCase()];
}

export function routingText(messages: ChatMessage[]): {
  prompt: string;
  systemPrompt: string | undefined;
} {
  const systemPrompt =
    messages
      .filter((message) => message.role === "system" && typeof message.content === "string")
      .map((message) => message.content as string)
      .join("\n") || undefined;
  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === "user" && typeof message.content === "string");
  const lastText = [...messages]
    .reverse()
    .find((message) => typeof message.content === "string");
  return {
    prompt: (lastUser?.content ?? lastText?.content ?? "") as string,
    systemPrompt,
  };
}

export function routeWithCatalog(
  prompt: string,
  systemPrompt: string | undefined,
  maxOutputTokens: number,
  modelPricing: Map<string, ModelPricing>,
  options: {
    routingProfile?: RoutingProfile;
    requiresStructuredOutput?: boolean;
    tools?: ChatCompletionOptions["tools"];
    toolChoice?: ChatCompletionOptions["toolChoice"];
    minimumPaymentUsd?: number;
  } = {},
): RoutingDecision {
  const tools = options.tools ?? [];
  const requiresTools =
    options.toolChoice === "none"
      ? false
      : options.toolChoice === "required" || typeof options.toolChoice === "object"
        ? true
        : undefined;
  const decision = routeRequest(prompt, systemPrompt, maxOutputTokens, {
    config: DEFAULT_ROUTING_CONFIG,
    modelPricing,
    routingProfile: options.routingProfile,
    hasTools: tools.length > 0,
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.function.name),
    requiresTools,
    requiresStructuredOutput: options.requiresStructuredOutput,
  });
  const tierConfigs = decision.tierConfigs ?? DEFAULT_ROUTING_CONFIG.tiers;
  const fullChain = decision.candidates ?? getFallbackChain(decision.tier, tierConfigs);
  const availableCandidates = fullChain.filter((id) => modelPricing.has(id));
  if (availableCandidates.length === 0) {
    throw new Error("Router found no model that is present in the current BlockRun catalog.");
  }
  const model = availableCandidates[0];
  const estimatedInputTokens = Math.ceil(`${systemPrompt ?? ""} ${prompt}`.length / 4);
  const costs = calculateModelCost(
    model,
    modelPricing,
    estimatedInputTokens,
    maxOutputTokens,
    options.routingProfile,
  );
  const minimumPaymentUsd = options.minimumPaymentUsd ?? 0.001;
  const costEstimate = Math.max(costs.costEstimate, minimumPaymentUsd);
  const savings =
    options.routingProfile === "premium" || costs.baselineCost <= 0
      ? 0
      : Math.max(0, (costs.baselineCost - costEstimate) / costs.baselineCost);
  return {
    ...decision,
    ...costs,
    costEstimate,
    savings,
    model,
    reasoning:
      model === decision.model
        ? decision.reasoning
        : `${decision.reasoning} | catalog fallback: ${model}`,
    candidates: availableCandidates,
    candidateScores: decision.candidateScores?.filter((score) => modelPricing.has(score.model)),
    fallbacks: availableCandidates.slice(1),
  };
}
