/**
 * On-Chain Predictive Intelligence Engine
 * ---------------------------------------
 * Aggregates whale wallet movements, exchange flow deltas, and smart-money
 * accumulation/distribution signals to produce a probabilistic market bias.
 *
 * This module is intentionally dependency-free so it can run inside the
 * autonomous loop (architectEngine.ts) or be invoked from any HTTP route.
 */

export type ChainId = 'ethereum' | 'bitcoin' | 'solana' | 'base' | 'arbitrum';

export interface WhaleMovement {
  wallet: string;
  chain: ChainId;
  token: string;
  amountUsd: number;
  direction: 'to_exchange' | 'from_exchange' | 'self_custody' | 'unknown';
  timestamp: number;
  txHash: string;
}

export interface SmartMoneySignal {
  wallet: string;
  label: string;
  action: 'accumulate' | 'distribute' | 'hold';
  confidence: number; // 0..1
  weight: number;    // historical alpha score
  timestamp: number;
}

export interface ExchangeFlow {
  chain: ChainId;
  token: string;
  netflowUsd: number; // positive = exchange inflow (bearish), negative = outflow (bullish)
  window: '1h' | '24h' | '7d';
}

export interface MarketSnapshot {
  asset: string;
  price: number;
  volatility24h: number;
  timestamp: number;
}

export interface PredictiveReport {
  asset: string;
  bias: 'bullish' | 'bearish' | 'neutral';
  score: number;          // -1..1
  confidence: number;     // 0..1
  drivers: string[];
  generatedAt: number;
}

export class OnchainPredictiveEngine {
  private history: Map<string, PredictiveReport[]> = new Map();

  /**
   * Aggregate a market prediction from raw on-chain primitives.
   */
  public predict(
    snapshot: MarketSnapshot,
    whaleMoves: WhaleMovement[],
    smartMoney: SmartMoneySignal[],
    flows: ExchangeFlow[],
  ): PredictiveReport {
    const drivers: string[] = [];
    let score = 0;
    let weightSum = 0;

    // 1) Whale flow bias (large movements dominate short-term alpha).
    const whaleBias = this.scoreWhales(snapshot.asset, whaleMoves);
    score += whaleBias.value * 0.4;
    weightSum += 0.4;
    if (whaleBias.note) drivers.push(whaleBias.note);

    // 2) Smart money consensus.
    const smartBias = this.scoreSmartMoney(smartMoney);
    score += smartBias.value * 0.35;
    weightSum += 0.35;
    if (smartBias.note) drivers.push(smartBias.note);

    // 3) Exchange netflow pressure.
    const flowBias = this.scoreExchangeFlows(snapshot.asset, flows);
    score += flowBias.value * 0.25;
    weightSum += 0.25;
    if (flowBias.note) drivers.push(flowBias.note);

    if (weightSum === 0) weightSum = 1;
    const normalized = score / weightSum;

    const bias: PredictiveReport['bias'] =
      normalized > 0.15 ? 'bullish' :
      normalized < -0.15 ? 'bearish' : 'neutral';

    // Confidence = absolute conviction + sample size bonus.
    const sampleSize = whaleMoves.length + smartMoney.length + flows.length;
    const confidence = Math.min(1, Math.abs(normalized) * 0.8 + Math.min(sampleSize, 20) / 40);

    const report: PredictiveReport = {
      asset: snapshot.asset,
      bias,
      score: Number(normalized.toFixed(4)),
      confidence: Number(confidence.toFixed(4)),
      drivers,
      generatedAt: Date.now(),
    };

    this.record(report);
    return report;
  }

  public getHistory(asset: string): PredictiveReport[] {
    return this.history.get(asset.toUpperCase()) ?? [];
  }

  private record(report: PredictiveReport): void {
    const key = report.asset.toUpperCase();
    const list = this.history.get(key) ?? [];
    list.push(report);
    if (list.length > 500) list.shift();
    this.history.set(key, list);
  }

  private scoreWhales(
    asset: string,
    moves: WhaleMovement[],
  ): { value: number; note?: string } {
    if (moves.length === 0) return { value: 0 };
    const target = asset.toUpperCase();
    let inflow = 0;
    let outflow = 0;
    for (const m of moves) {
      if (m.token.toUpperCase() !== target) continue;
      if (m.direction === 'to_exchange') inflow += m.amountUsd;
      else if (m.direction === 'from_exchange' || m.direction === 'self_custody') outflow += m.amountUsd;
    }
    const delta = outflow - inflow;
    const magnitude = Math.max(Math.abs(delta), 1);
    const value = Math.tanh(delta / magnitude);
    return {
      value,
      note: `Whale flow delta $${delta.toLocaleString()} (${inflow > 0 || outflow > 0 ? 'significant' : 'flat'})`,
    };
  }

  private scoreSmartMoney(
    signals: SmartMoneySignal[],
  ): { value: number; note?: string } {
    if (signals.length === 0) return { value: 0 };
    let bull = 0;
    let bear = 0;
    let totalWeight = 0;
    for (const s of signals) {
      const w = s.weight * s.confidence;
      totalWeight += w;
      if (s.action === 'accumulate') bull += w;
      else if (s.action === 'distribute') bear += w;
    }
    if (totalWeight === 0) return { value: 0 };
    const value = (bull - bear) / totalWeight;
    return { value, note: `Smart-money consensus ${(value * 100).toFixed(1)}% bullish across ${signals.length} wallets` };
  }

  private scoreExchangeFlows(
    asset: string,
    flows: ExchangeFlow[],
  ): { value: number; note?: string } {
    if (flows.length === 0) return { value: 0 };
    const target = asset.toUpperCase();
    let net = 0;
    let count = 0;
    for (const f of flows) {
      if (f.token.toUpperCase() !== target) continue;
      const windowFactor = f.window === '1h' ? 1.5 : f.window === '24h' ? 1.0 : 0.5;
      net += -f.netflowUsd * windowFactor;
      count++;
    }
    if (count === 0) return { value: 0 };
    const value = Math.tanh(net / Math.max(Math.abs(net), 1));
    return { value, note: `Exchange netflow pressure ${(value * 100).toFixed(1)}% (${count} venues)` };
  }
}

export const onchainPredictiveEngine = new OnchainPredictiveEngine();
