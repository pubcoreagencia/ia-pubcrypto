import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

// ============================================================
// ON-CHAIN PREDICTIVE ENGINE
// Real-time exchange flow imbalance detector combined with
// whale wallet clustering and predictive signal emission.
// ============================================================

export type ChainId = 'bitcoin' | 'ethereum' | 'solana' | 'bsc' | 'polygon';

export interface ExchangeFlow {
  chain: ChainId;
  exchange: string;
  netInflow: number;     // positive = coins entering exchange (sell pressure)
  netOutflow: number;    // positive = coins leaving exchange (accumulation)
  largeTxCount: number;  // count of whale-sized transactions (> $1M)
  timestamp: number;
}

export interface WhaleCluster {
  address: string;
  chain: ChainId;
  balanceUsd: number;
  activityScore: number; // 0..100
  tags: string[];        // e.g. ['fund', 'market-maker', 'dormant']
}

export interface PredictiveSignal {
  id: string;
  chain: ChainId;
  type: 'accumulation' | 'distribution' | 'whale_rotation' | 'exchange_drain';
  confidence: number;        // 0..1
  expectedImpactBps: number; // expected basis points move
  horizon: '1h' | '4h' | '24h';
  rationale: string;
  generatedAt: number;
  expiresAt: number;
}

export interface EngineConfig {
  inflowThresholdUsd: number;
  outflowThresholdUsd: number;
  whaleUsdThreshold: number;
  minClusterSignals: number;
  signalTtlMs: number;
}

const DEFAULT_CONFIG: EngineConfig = {
  inflowThresholdUsd: 25_000_000,
  outflowThresholdUsd: 25_000_000,
  whaleUsdThreshold: 1_000_000,
  minClusterSignals: 3,
  signalTtlMs: 60 * 60 * 1000,
};

export class OnchainPredictiveEngine extends EventEmitter {
  private config: EngineConfig;
  private flows: Map<string, ExchangeFlow[]> = new Map();
  private clusters: Map<string, WhaleCluster> = new Map();
  private signals: PredictiveSignal[] = [];
  private history: PredictiveSignal[] = [];
  private rollingWindowMs = 24 * 60 * 60 * 1000;

  constructor(config: Partial<EngineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  public ingestFlow(flow: ExchangeFlow): PredictiveSignal[] {
    const key = `${flow.chain}:${flow.exchange}`;
    const arr = this.flows.get(key) ?? [];
    arr.push(flow);
    this.flows.set(key, this.pruneOld(arr));

    const generated = this.evaluateFlow(flow);
    generated.forEach((s) => this.registerSignal(s));
    return generated;
  }

  public upsertCluster(cluster: WhaleCluster): void {
    this.clusters.set(cluster.address, cluster);
  }

  public getActiveSignals(chain?: ChainId): PredictiveSignal[] {
    const now = Date.now();
    return this.signals.filter(
      (s) => s.expiresAt > now && (!chain || s.chain === chain),
    );
  }

  public getSignalAccuracy(): { total: number; hits: number; ratio: number } {
    const total = this.history.length;
    if (total === 0) return { total: 0, hits: 0, ratio: 0 };
    const hits = this.history.filter((s) => (s as any)._resolvedHit).length;
    return { total, hits, ratio: hits / total };
  }

  public resolveSignal(signalId: string, hit: boolean): void {
    const idx = this.signals.findIndex((s) => s.id === signalId);
    if (idx === -1) return;
    const [s] = this.signals.splice(idx, 1);
    (s as any)._resolvedHit = hit;
    this.history.push(s);
  }

  // ----------------------------------------------------------
  // Core logic
  // ----------------------------------------------------------

  private evaluateFlow(flow: ExchangeFlow): PredictiveSignal[] {
    const signals: PredictiveSignal[] = [];
    const imbalance = flow.netOutflow - flow.netInflow;

    // 1. Exchange drain / refill detection
    if (flow.netOutflow >= this.config.outflowThresholdUsd && imbalance > 0) {
      signals.push(this.buildSignal(flow, 'exchange_drain', 0.82, 35, '24h',
        `Exchange ${flow.exchange} on ${flow.chain} draining ${flow.netOutflow.toLocaleString()} USD — historical bullish bias.`));
    } else if (flow.netInflow >= this.config.inflowThresholdUsd && imbalance < 0) {
      signals.push(this.buildSignal(flow, 'distribution', 0.74, -28, '24h',
        `Exchange ${flow.exchange} receiving ${flow.netInflow.toLocaleString()} USD — elevated sell-side pressure.`));
    }

    // 2. Whale rotation signal
    if (flow.largeTxCount >= this.config.minClusterSignals) {
      const clusterSignal = this.detectWhaleRotation(flow);
      if (clusterSignal) signals.push(clusterSignal);
    }

    // 3. Pure accumulation pattern
    if (flow.netOutflow > flow.netInflow * 2 && flow.netOutflow > 10_000_000) {
      signals.push(this.buildSignal(flow, 'accumulation', 0.69, 18, '4h',
        `Net outflow ${(flow.netOutflow - flow.netInflow).toLocaleString()} USD on ${flow.chain} suggests accumulation phase.`));
    }

    return signals;
  }

  private detectWhaleRotation(flow: ExchangeFlow): PredictiveSignal | null {
    const chainClusters = Array.from(this.clusters.values())
      .filter((c) => c.chain === flow.chain && c.balanceUsd >= this.config.whaleUsdThreshold);

    if (chainClusters.length < this.config.minClusterSignals) return null;

    const active = chainClusters.filter((c) => c.activityScore >= 60);
    if (active.length === 0) return null;

    const totalBalance = active.reduce((acc, c) => acc + c.balanceUsd, 0);
    const confidence = Math.min(0.95, 0.55 + active.length * 0.05 + (totalBalance > 500_000_000 ? 0.1 : 0));

    return this.buildSignal(flow, 'whale_rotation', confidence, 22, '4h',
      `${active.length} whale clusters active on ${flow.chain} with combined exposure ${(totalBalance / 1e9).toFixed(2)}B USD.`);
  }

  private buildSignal(
    flow: ExchangeFlow,
    type: PredictiveSignal['type'],
    confidence: number,
    impactBps: number,
    horizon: PredictiveSignal['horizon'],
    rationale: string,
  ): PredictiveSignal {
    const now = Date.now();
    return {
      id: `${flow.chain}-${type}-${now}-${Math.random().toString(36).slice(2, 8)}`,
      chain: flow.chain,
      type,
      confidence: Number(confidence.toFixed(3)),
      expectedImpactBps: impactBps,
      horizon,
      rationale,
      generatedAt: now,
      expiresAt: now + this.config.signalTtlMs,
    };
  }

  private registerSignal(signal: PredictiveSignal): void {
    this.signals.push(signal);
    this.emit('signal', signal);
    logger.info(`[onchain] signal ${signal.type} @ ${signal.chain} conf=${signal.confidence}`);
  }

  private pruneOld(arr: ExchangeFlow[]): ExchangeFlow[] {
    const cutoff = Date.now() - this.rollingWindowMs;
    return arr.filter((f) => f.timestamp >= cutoff);
  }
}

// -----------------------------------------------------------
// Singleton accessor used by the autonomous runtime
// -----------------------------------------------------------
let instance: OnchainPredictiveEngine | null = null;

export function getPredictiveEngine(config?: Partial<EngineConfig>): OnchainPredictiveEngine {
  if (!instance) instance = new OnchainPredictiveEngine(config);
  return instance;
}
