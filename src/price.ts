/**
 * Prices for models AutoHeal's table does not list. OpenRouter publishes the
 * price of every model it serves, so for an OpenRouter base URL KeepGreen
 * looks the model up instead of running with no dollar cap. It is a plain GET
 * of the public model list: no key and nothing about your project goes with it.
 */

export interface LookupOptions {
  fetchFn?: typeof fetch;
  log?: (line: string) => void;
  timeoutMs?: number;
}

/** USD per 1M tokens [in, out], or null when unknown. */
export async function lookupPrice(model: string, baseUrl: string | undefined, options: LookupOptions = {}): Promise<[number, number] | null> {
  if (!baseUrl || !model) return null;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return null;
  }
  if (host !== 'openrouter.ai' && !host.endsWith('.openrouter.ai')) return null;
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const res = await fetchFn('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }> };
    const entry = body.data?.find((m) => m.id === model);
    const pin = Number(entry?.pricing?.prompt);
    const pout = Number(entry?.pricing?.completion);
    if (!entry || !Number.isFinite(pin) || !Number.isFinite(pout) || pin < 0 || pout < 0) return null;
    const price: [number, number] = [round(pin * 1e6), round(pout * 1e6)];
    options.log?.(`OpenRouter price for ${model}: $${price[0]} in / $${price[1]} out per 1M tokens`);
    return price;
  } catch {
    return null;
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
