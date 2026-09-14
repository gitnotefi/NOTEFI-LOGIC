import { Router, type IRouter } from "express";

const router: IRouter = Router();
const ROBINHOOD_API = "https://api.robinhood.com/rhj";
const DEX_API = "https://api.dexscreener.com";
const CHAIN_ID = 4663;
const CHAIN_SLUG = "robinhood";
const RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
// These are the documented market assets surfaced by the swap screen. Keep
// them in discovery even when the upstream catalog ordering changes; a
// registry listing alone is not proof that a pool or quote exists.
const ROUTER_MARKET_SYMBOLS = [
  "NVDA", "AVGO", "TSM", "AMD", "AAPL", "MSFT",
  "GOOGL", "AMZN", "META", "TSLA", "GLD",
];
const cache = new Map<string, { expiresAt: number; value: unknown }>();
const requests = new Map<string, { windowStart: number; count: number }>();
const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const HEX_DATA = /^0x(?:[a-fA-F0-9]{2})*$/;
const RPC_METHODS = new Set([
  "eth_call", "eth_chainId", "eth_getBalance", "eth_blockNumber", "eth_getCode",
  "eth_gasPrice", "eth_getTransactionCount", "eth_estimateGas",
]);
const POOL_REFERENCE = /^0x(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;

type Deployment = { contractAddress: string; chainId: number };
type RobinhoodAsset = {
  tokenSymbol: string; tokenName: string; deployments?: Deployment[];
  currentMultiplier?: string; tokenDecimals?: number; status?: string;
};
type RobinhoodQuote = { tokenSymbol: string; bid: string; ask: string; generatedAt: string; isTradingHalt: boolean };
type DexPair = {
  chainId?: string; pairAddress?: string; dexId?: string; url?: string;
  labels?: string[];
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string; liquidity?: { usd?: number }; volume?: { h24?: number };
  priceChange?: { h24?: number }; txns?: { h24?: { buys?: number; sells?: number } };
  pairCreatedAt?: number; info?: { imageUrl?: string; header?: string };
};

function rateLimited(key: string): boolean {
  const now = Date.now(), current = requests.get(key);
  if (!current || now - current.windowStart > 60_000) {
    requests.set(key, { windowStart: now, count: 1 }); return false;
  }
  current.count += 1;
  return current.count > 30;
}

async function getJson<T>(url: string, ttlMs: number): Promise<T> {
  const hit = cache.get(url);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "xindex-protocol/0.1" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`);
  const value: unknown = await response.json();
  if (value == null || typeof value !== "object") throw new Error("Invalid upstream response");
  cache.set(url, { expiresAt: Date.now() + ttlMs, value });
  return value as T;
}

async function catalog(): Promise<ReturnType<typeof toCatalog>> {
  const payload = await getJson<{ assets?: RobinhoodAsset[] }>(`${ROBINHOOD_API}/assets`, 300_000);
  if (!Array.isArray(payload.assets)) throw new Error("Invalid Robinhood asset catalog");
  return payload.assets.flatMap(toCatalog);
}

function toCatalog(asset: RobinhoodAsset) {
  if (typeof asset.tokenSymbol !== "string" || !Array.isArray(asset.deployments)) return [];
  const status = String(asset.status ?? "unknown");
  if (!["active", "asset_status_active", "trading", "enabled", "live"].includes(status.toLowerCase())) return [];
  const d = asset.deployments.find((x) => x.chainId === CHAIN_ID && ADDRESS.test(x.contractAddress));
  if (!d) return [];
  return [{
    symbol: asset.tokenSymbol.toUpperCase(), name: asset.tokenName, address: d.contractAddress,
    decimals: Number.isInteger(asset.tokenDecimals) ? asset.tokenDecimals : null,
    multiplier: asset.currentMultiplier ?? null, status,
  }];
}

async function quote(symbol: string) {
  try {
    const payload = await getJson<{ quotes?: RobinhoodQuote[] }>(`${ROBINHOOD_API}/prices/${encodeURIComponent(symbol)}`, 15_000);
    const q = payload.quotes?.find((x) => x.tokenSymbol?.toUpperCase() === symbol);
    if (!q) return null;
    const bid = Number(q.bid), ask = Number(q.ask), age = Date.now() - Date.parse(q.generatedAt);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid ||
        !Number.isFinite(age) || age < 0 || age > 120_000 || q.isTradingHalt) return null;
    return { bid: q.bid, ask: q.ask, asOf: q.generatedAt, halted: false };
  } catch { return null; }
}

function pairResult(p: DexPair) {
  if (p.chainId !== CHAIN_SLUG || !p.pairAddress || !POOL_REFERENCE.test(p.pairAddress) ||
      !p.baseToken?.address || !p.quoteToken?.address || !ADDRESS.test(p.baseToken.address) ||
      !ADDRESS.test(p.quoteToken.address)) return null;
  const https = (v?: string) => v?.startsWith("https://") ? v : undefined;
  const tx = p.txns?.h24;
  return {
    pairAddress: p.pairAddress, dexId: p.dexId ?? null,
    labels: Array.isArray(p.labels) ? p.labels.filter((x): x is string => typeof x === "string") : [],
    baseToken: { address: p.baseToken.address, symbol: p.baseToken.symbol ?? null, name: p.baseToken.name ?? null },
    quoteToken: { address: p.quoteToken.address, symbol: p.quoteToken.symbol ?? null, name: p.quoteToken.name ?? null },
    priceUsd: p.priceUsd ?? null, liquidityUsd: Number.isFinite(p.liquidity?.usd) ? p.liquidity?.usd : null,
    volume24h: Number.isFinite(p.volume?.h24) ? p.volume?.h24 : null,
    priceChange24h: Number.isFinite(p.priceChange?.h24) ? p.priceChange?.h24 : null,
    txns24h: tx ? { buys: tx.buys ?? 0, sells: tx.sells ?? 0 } : null,
    pairCreatedAt: p.pairCreatedAt ?? null, logoUrl: https(p.info?.imageUrl), imageUrl: https(p.info?.header),
    url: https(p.url),
  };
}

async function discovery(): Promise<ReturnType<typeof pairResult>[]> {
  const cat = await catalog();
  const terms = [
    ...new Set(["USDG", "WETH", ...ROUTER_MARKET_SYMBOLS, ...cat.slice(0, 8).map((x) => x.symbol)]),
  ].slice(0, 24);
  const responses = await Promise.all(terms.map((q) =>
    getJson<{ pairs?: DexPair[] }>(`${DEX_API}/latest/dex/search?q=${encodeURIComponent(q)}`, 30_000).catch(() => ({ pairs: [] }))));
  const pairs = responses.flatMap((r) => r.pairs ?? []).map(pairResult).filter((p): p is NonNullable<ReturnType<typeof pairResult>> => p !== null);
  const addresses = [...new Set(pairs.flatMap((p) => [p.baseToken.address, p.quoteToken.address]))].slice(0, 12);
  const direct = await Promise.all(addresses.map((a) =>
    getJson<DexPair[]>(`${DEX_API}/token-pairs/v1/${CHAIN_SLUG}/${a}`, 30_000).catch(() => [])));
  const all = [...pairs, ...direct.flatMap((r) => r).map(pairResult).filter((p): p is NonNullable<ReturnType<typeof pairResult>> => p !== null)];
  const unique = new Map(all.map((p) => [p.pairAddress.toLowerCase(), p]));
  return [...unique.values()].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0) || (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, 100);
}

router.get("/protocol/catalog", async (req, res): Promise<void> => {
  if (rateLimited(req.ip || "unknown")) { res.status(429).json({ error: "Rate limit exceeded" }); return; }
  try { res.json({ source: "Robinhood Stock Token API", chainId: CHAIN_ID, fetchedAt: new Date().toISOString(), assets: await catalog() }); }
  catch (error) { req.log.error({ err: error }, "protocol catalog failed"); res.status(502).json({ error: "Market catalog unavailable" }); }
});

router.get("/protocol/assets", async (req, res): Promise<void> => {
  if (rateLimited(req.ip || "unknown")) { res.status(429).json({ error: "Rate limit exceeded" }); return; }
  const symbols = String(req.query.symbols ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length || symbols.length > 30 || new Set(symbols).size !== symbols.length) { res.status(400).json({ error: "Provide 1-30 symbols" }); return; }
  try {
    const cat = await catalog(), by = new Map(cat.map((x) => [x.symbol, x]));
    const assets = await Promise.all(symbols.map(async (symbol) => {
      const item = by.get(symbol); if (!item) throw new Error(`Unsupported or undeployed symbol: ${symbol}`);
      return { ...item, price: await quote(symbol) };
    }));
    res.setHeader("Cache-Control", "public, max-age=10, stale-while-revalidate=20");
    res.json({ source: "Robinhood Stock Token API", chainId: CHAIN_ID, fetchedAt: new Date().toISOString(), assets });
  } catch (error) { req.log.error({ err: error }, "protocol assets failed"); res.status(502).json({ error: error instanceof Error ? error.message : "Market data unavailable" }); }
});

router.get("/protocol/discovery", async (req, res): Promise<void> => {
  if (rateLimited(req.ip || "unknown")) { res.status(429).json({ error: "Rate limit exceeded" }); return; }
  try { const pairs = await discovery(); res.setHeader("Cache-Control", "public, max-age=20"); res.json({ source: "DexScreener discovered active pools", chainId: CHAIN_ID, fetchedAt: new Date().toISOString(), pairs }); }
  catch (error) { req.log.error({ err: error }, "protocol discovery failed"); res.status(502).json({ error: "Pool discovery unavailable" }); }
});

router.get("/protocol/token-search", async (req, res): Promise<void> => {
  if (rateLimited(req.ip || "unknown")) { res.status(429).json({ error: "Rate limit exceeded" }); return; }
  const q = String(req.query.q ?? "").trim(); if (!q) { res.status(400).json({ error: "q is required" }); return; }
  try {
    const local = (await catalog()).filter((x) => `${x.symbol} ${x.name} ${x.address}`.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
    const pools = q.length < 2 ? [] : (await getJson<{ pairs?: DexPair[] }>(`${DEX_API}/latest/dex/search?q=${encodeURIComponent(q)}`, 30_000).catch(() => ({ pairs: [] }))).pairs?.map(pairResult).filter((p): p is NonNullable<ReturnType<typeof pairResult>> => p !== null).slice(0, 30) ?? [];
    res.json({ chainId: CHAIN_ID, query: q, assets: local, pools });
  } catch (error) { req.log.error({ err: error }, "protocol token search failed"); res.status(502).json({ error: "Token search unavailable" }); }
});

router.get("/protocol/ticker", async (req, res): Promise<void> => {
  if (rateLimited(req.ip || "unknown")) { res.status(429).json({ error: "Rate limit exceeded" }); return; }
  try {
    const cat = await catalog(), stocks = await Promise.all(cat.slice(0, 12).map(async (a) => ({ ...a, price: await quote(a.symbol) })));
    res.json({ chainId: CHAIN_ID, fetchedAt: new Date().toISOString(), stocks, pools: (await discovery()).slice(0, 30) });
  } catch (error) { req.log.error({ err: error }, "protocol ticker failed"); res.status(502).json({ error: "Ticker unavailable" }); }
});

function callData(signature: string, address: string): string {
  return signature + address.slice(2).toLowerCase().padStart(64, "0");
}
function decodeUint(hex: string): bigint { return BigInt(hex || "0x0"); }
function decodeText(hex: string): string | null {
  try { const b = Buffer.from(hex.replace(/^0x/, ""), "hex"); const offset = Number(BigInt(`0x${b.subarray(0, 32).toString("hex")}`)); const len = Number(BigInt(`0x${b.subarray(offset, offset + 32).toString("hex")}`)); return b.subarray(offset + 32, offset + 32 + len).toString().replace(/\0/g, "") || null; } catch { return null; }
}
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

function validRpcParams(method: string, params: unknown): boolean {
  if (!Array.isArray(params) || params.length > 2) return false;
  if (method === "eth_chainId" || method === "eth_blockNumber" || method === "eth_gasPrice") return params.length === 0;
  if (method === "eth_getBalance" || method === "eth_getCode" || method === "eth_getTransactionCount") {
    return params.length === 2 && typeof params[0] === "string" && ADDRESS.test(params[0]) &&
      (params[1] === "latest" || params[1] === "pending" || (typeof params[1] === "string" && /^0x[0-9a-fA-F]+$/.test(params[1])));
  }
  if (method === "eth_call" || method === "eth_estimateGas") {
    if (!params.length || !params[0] || typeof params[0] !== "object") return false;
    const call = params[0] as Record<string, unknown>;
    if (typeof call.to !== "string" || !ADDRESS.test(call.to)) return false;
    if (call.data !== undefined && (typeof call.data !== "string" || !HEX_DATA.test(call.data) || call.data.length > 131_074)) return false;
    if (call.value !== undefined && (typeof call.value !== "string" || !/^0x[0-9a-fA-F]+$/.test(call.value))) return false;
    return method === "eth_estimateGas" || params.length === 2 && params[1] === "latest";
  }
  return false;
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null, error: { code, message } };
}

router.post("/protocol/rpc", async (req, res): Promise<void> => {
  if (rateLimited(`rpc:${req.ip || "unknown"}`)) {
    res.status(429).json(rpcError(null, -32029, "Rate limit exceeded"));
    return;
  }
  const body = req.body as unknown;
  const batch = Array.isArray(body) ? body : [body];
  if (!batch.length || batch.length > 8 || JSON.stringify(body ?? null).length > 30_000) {
    res.status(400).json(rpcError(null, -32600, "Invalid JSON-RPC request"));
    return;
  }
  const requests = batch as JsonRpcRequest[];
  for (const request of requests) {
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string" ||
        !RPC_METHODS.has(request.method) || !validRpcParams(request.method, request.params ?? [])) {
      const id = request && typeof request === "object" ? request.id : null;
      res.status(400).json(Array.isArray(body) ? [rpcError(id, -32600, "Invalid read-only JSON-RPC request")] : rpcError(id, -32600, "Invalid read-only JSON-RPC request"));
      return;
    }
  }
  const forward = async (request: JsonRpcRequest): Promise<unknown> => {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const upstream = await fetch(RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(7_000),
        });
        if (!upstream.ok) throw new Error("upstream unavailable");
        const response = await upstream.json() as unknown;
        if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("invalid upstream response");
        return response;
      } catch (error) {
        last = error;
        if (attempt === 0) await wait(120);
      }
    }
    return rpcError(request.id, -32002, "RPC upstream unavailable");
  };
  try {
    const responses = await Promise.all(requests.map(forward));
    res.json(Array.isArray(body) ? responses : responses[0]);
  } catch {
    res.status(502).json(rpcError(null, -32002, "RPC upstream unavailable"));
  }
});

router.get("/protocol/portfolio/:address", async (req, res): Promise<void> => {
  const address = Array.isArray(req.params.address) ? req.params.address[0] : req.params.address;
  if (!ADDRESS.test(address)) { res.status(400).json({ error: "Invalid EVM address" }); return; }
  if (rateLimited(req.ip || "unknown")) { res.status(429).json({ error: "Rate limit exceeded" }); return; }
  const raw = String(req.query.tokens ?? "");
  if (raw.split(",").filter(Boolean).length > 250) { res.status(400).json({ error: "At most 250 tokens" }); return; }
  try {
    const cat = await catalog(), discovered = raw ? [] : await discovery();
    const bySymbol = new Map(cat.map((x) => [x.symbol, x]));
    const byAddress = new Map(cat.map((x) => [x.address.toLowerCase(), x]));
    const requested = raw.split(",").map((x) => x.trim()).filter(Boolean);
    if (raw && requested.some((x) => !ADDRESS.test(x) && !bySymbol.has(x.toUpperCase()))) {
      res.status(400).json({ error: "tokens must be EVM addresses or catalog symbols" }); return;
    }
    const tokens = (raw ? requested.map((x) => bySymbol.get(x.toUpperCase())?.address ?? x) : [...cat.map((x) => x.address), ...discovered.flatMap((p) => p ? [p.baseToken.address, p.quoteToken.address] : [])]).filter((x, i, a) => ADDRESS.test(x) && a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i).slice(0, 250);
    const holdings = [], errors = [];
    type RpcResult = { result?: string; error?: { message?: string } };
    async function runBatches(calls: Array<{ token: string; data: string }>, batchSize: number): Promise<Map<number, RpcResult>> {
      const results = new Map<number, RpcResult>();
      for (let start = 0; start < calls.length; start += batchSize) {
        if (start > 0) await wait(200);
        const chunk = calls.slice(start, start + batchSize).map((c, offset) => ({
          jsonrpc: "2.0", id: offset, method: "eth_call",
          params: [{ to: c.token, data: c.data }, "latest"],
        }));
        try {
          const response = await fetch(RPC_URL, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(chunk), signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw new Error(`RPC returned ${response.status}`);
          const result = await response.json() as Array<{ id: number; result?: string; error?: { message?: string } }>;
          if (!Array.isArray(result)) throw new Error("Invalid RPC batch response");
          for (const item of result) results.set(item.id + start, item);
        } catch (error) {
          const message = error instanceof Error ? error.message : "RPC batch failed";
          for (let offset = 0; offset < chunk.length; offset++) results.set(start + offset, { error: { message } });
        }
      }
      return results;
    }
    // Balance reads dominate this endpoint, so do them alone first. This keeps
    // the usual catalog request to three 100-call batches instead of 1,000.
    const balanceResults = await runBatches(tokens.map((token) => ({ token, data: callData("0x70a08231", address) })), 100);
    const positive = [];
    for (let i = 0; i < tokens.length; i++) {
      const result = balanceResults.get(i);
      if (!result?.result || result.error) {
        errors.push({ address: tokens[i], error: result?.error?.message ?? "balanceOf failed" });
        continue;
      }
      const balance = decodeUint(result.result);
      if (balance > 0n) positive.push({ address: tokens[i], balance: balance.toString(), metadata: byAddress.get(tokens[i].toLowerCase()) });
    }
    const metadataCalls: Array<{ token: string; data: string; kind: "decimals" | "symbol" | "name" }> = [];
    for (const holding of positive) {
      if (holding.metadata?.decimals == null) metadataCalls.push({ token: holding.address, data: "0x313ce567", kind: "decimals" });
      if (holding.metadata?.symbol == null) metadataCalls.push({ token: holding.address, data: "0x95d89b41", kind: "symbol" });
      if (holding.metadata?.name == null) metadataCalls.push({ token: holding.address, data: "0x06fdde03", kind: "name" });
    }
    const metadataResults = await runBatches(metadataCalls, 80);
    for (let i = 0; i < positive.length; i++) {
      const holding = positive[i], metadata = holding.metadata;
      const values: { decimals: number | null; symbol: string | null; name: string | null } = {
        decimals: metadata?.decimals ?? null, symbol: metadata?.symbol ?? null, name: metadata?.name ?? null,
      };
      for (const [kind, data] of [["decimals", "0x313ce567"], ["symbol", "0x95d89b41"], ["name", "0x06fdde03"]] as const) {
        if (metadata && ((kind === "decimals" && metadata.decimals != null) || (kind === "symbol" && metadata.symbol != null) || (kind === "name" && metadata.name != null))) continue;
        const callIndex = metadataCalls.findIndex((call) => call.token.toLowerCase() === holding.address.toLowerCase() && call.kind === kind);
        const result = callIndex < 0 ? undefined : metadataResults.get(callIndex);
        if (!result?.result || result.error) errors.push({ address: holding.address, error: result?.error?.message ?? `${kind} read failed` });
        else if (kind === "decimals") values.decimals = Number(decodeUint(result.result));
        else values[kind] = decodeText(result.result);
      }
      holdings.push({ address: holding.address, balance: holding.balance, ...values });
    }
    res.json({ chainId: CHAIN_ID, address, holdings, errors });
  } catch (error) { req.log.error({ err: error }, "protocol portfolio failed"); res.status(502).json({ error: "Portfolio unavailable" }); }
});

export default router;