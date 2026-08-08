import { computeCostUsd, type AnthropicLike } from "@silly-rabbit/engine";

export interface UsageTotals {
  llmCallsUsed: number;
  costUsd: number;
}

export interface TrackedClientFactory {
  clientFactory: () => AnthropicLike;
  totals: UsageTotals;
}

export function trackClientUsage(clientFactory: () => AnthropicLike): TrackedClientFactory {
  const totals: UsageTotals = { llmCallsUsed: 0, costUsd: 0 };

  const wrappedFactory = (): AnthropicLike => {
    const client = clientFactory();
    return {
      messages: {
        create: async (parameters) => {
          const response = await client.messages.create(parameters);
          totals.llmCallsUsed += 1;
          totals.costUsd += computeCostUsd(parameters.model, response.usage);
          return response;
        },
      },
    };
  };

  return { clientFactory: wrappedFactory, totals };
}
