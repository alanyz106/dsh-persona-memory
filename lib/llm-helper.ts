/**
 * Shared LLM helpers for the auto features (background learning, consolidation):
 * resolving the session's own provider/model route and streaming one text reply.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';

export interface LlmRoute {
  provider: string;
  model: string;
}

/**
 * Resolve the host's default provider/model without requiring a prior chat
 * request. `agentDefaultModel` is configured by the active profile patch and
 * is what Agent entry points use for fresh sessions. `ctx.get` keeps this
 * optional: hosts/older versions without the service simply fall back to the
 * session-recorded route.
 */
export function defaultLlmRoute(ctx: Context): LlmRoute | undefined {
  try {
    const service = ctx.get?.('agentDefaultModel') as {
      currentSelection?: () => { provider?: unknown; model?: unknown };
    } | undefined;
    const selection = service?.currentSelection?.();
    if (typeof selection?.provider === 'string' && selection.provider.trim()
      && typeof selection.model === 'string' && selection.model.trim()) {
      return { provider: selection.provider.trim(), model: selection.model.trim() };
    }
  } catch {
    // A missing or incompatible service must never break the memory plugin.
  }
  return undefined;
}

/**
 * Prefer the route last used by a real session (it may be an explicit model
 * override), otherwise inherit the deployment's default provider/model.
 */
export function resolveLlmRoute(ctx: Context, sessionRoute?: LlmRoute | undefined): LlmRoute | undefined {
  return sessionRoute ?? defaultLlmRoute(ctx);
}

/** @returns the session's latest request route */
export function latestRoute(session: Session): LlmRoute | undefined {
  const events = sessionEvents(session);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'request/header') {
      const config = event.data?.header?.config;
      if (config?.provider && config?.model) {
        return { provider: config.provider, model: config.model };
      }
    }
  }
  return undefined;
}

/**
 * Read the session event log across dsh epochs: 0.1.x exposes the array as
 * `session.events`, 0.2.x as `session.snapshotEvents()`. Returns an empty log
 * for any other shape so callers degrade instead of throwing.
 */
export function sessionEvents(session: Session): readonly SessionEvent[] {
  const carrier = session as unknown as {
    events?: readonly SessionEvent[];
    snapshotEvents?: () => readonly SessionEvent[];
  };
  if (Array.isArray(carrier.events)) return carrier.events;
  if (typeof carrier.snapshotEvents === 'function') {
    const snapshot = carrier.snapshotEvents();
    if (Array.isArray(snapshot)) return snapshot;
  }
  return [];
}

/**
 * Stream one auxiliary text completion from the session's own LLM route.
 * @returns assembled text output
 */
export async function callLlm(ctx: Context, route: LlmRoute, system: string, prompt: string, timeoutMs: number): Promise<string> {
  // AbortSignal.timeout() is the real deadline. Mirror it on `.timeout` too:
  // older hosts/tests may inspect the signal, and it makes the configured
  // migration timeout verifiable without waiting for the deadline itself.
  const signal = AbortSignal.timeout(timeoutMs) as AbortSignal & { timeout?: number };
  (signal as { timeout?: number }).timeout = timeoutMs;
  const messages = [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })];
  let out = '';
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages,
    signal,
  });
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') out += chunk.text;
  }
  return out;
}
