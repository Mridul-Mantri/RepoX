import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import Redlock, { Lock } from 'redlock';

/**
 * Centralised Redis access.
 *
 * Three responsibilities:
 *  1. Generic key-value cache (e.g. session, counters, sliding-window fraud checks)
 *  2. Distributed locks via Redlock — used to guarantee no double-booking when
 *     two buyers try to "Buy Now" the same vehicle concurrently across multiple
 *     API pods. Postgres row-level locks alone wouldn't compose well with the
 *     10-minute reservation window, so we layer a Redis lock + a DB hold.
 *  3. Pub/sub backbone for Socket.io horizontal scaling (separate clients in the
 *     adapter — see realtime/redis-io.adapter.ts).
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  public client: Redis;
  public subscriber: Redis;
  private redlock: Redlock;

  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  onModuleInit() {
    const options = {
      host: this.config.get<string>('REDIS_HOST'),
      port: this.config.get<number>('REDIS_PORT'),
      password: this.config.get<string>('REDIS_PASSWORD') || undefined,
      db: this.config.get<number>('REDIS_DB') || 0,
      maxRetriesPerRequest: null, // required for ioredis 5+
      enableReadyCheck: true,
    };

    this.client = new Redis(options);
    this.subscriber = new Redis(options);

    this.client.on('connect', () => this.logger.log('✓ Redis connected'));
    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));

    // Redlock — single-instance for now. In prod, pass multiple ioredis clients
    // pointing at independent Redis nodes for true RedLock semantics.
    this.redlock = new Redlock([this.client], {
      driftFactor: 0.01,
      retryCount: 10,
      retryDelay: 200,
      retryJitter: 100,
      automaticExtensionThreshold: 500,
    });

    this.redlock.on('error', (err) => {
      // Don't crash on transient lock contention errors — they're expected.
      if (err.name === 'ResourceLockedError') return;
      this.logger.error(`Redlock error: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.client?.quit();
    await this.subscriber?.quit();
  }

  // ---- KV helpers ------------------------------------------------------------

  async get<T = string>(key: string): Promise<T | null> {
    const v = await this.client.get(key);
    if (!v) return null;
    try { return JSON.parse(v) as T; } catch { return v as unknown as T; }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const v = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlSeconds) await this.client.set(key, v, 'EX', ttlSeconds);
    else await this.client.set(key, v);
  }

  async del(...keys: string[]): Promise<number> {
    return this.client.del(...keys);
  }

  /**
   * Sliding-window counter — used for fraud detection ("X hold attempts in
   * Y seconds"). Returns the count after this increment.
   */
  async incrWindow(key: string, windowSeconds: number): Promise<number> {
    const multi = this.client.multi();
    multi.incr(key);
    multi.expire(key, windowSeconds);
    const results = await multi.exec();
    return (results?.[0]?.[1] as number) ?? 0;
  }

  // ---- Distributed locking ---------------------------------------------------

  /**
   * Acquire a lock and run `fn`. The lock is released automatically — even if
   * `fn` throws. Throws on contention if `retryCount` is exhausted.
   *
   * Use this around any operation that mutates a vehicle's hold/sale state.
   */
  async withLock<T>(
    resource: string,
    ttlMs: number,
    fn: (signal: { extend: (ttl: number) => Promise<void> }) => Promise<T>,
  ): Promise<T> {
    const lock: Lock = await this.redlock.acquire([`lock:${resource}`], ttlMs);
    try {
      return await fn({
        extend: async (ttl: number) => { await lock.extend(ttl); },
      });
    } finally {
      try { await lock.release(); }
      catch (err: any) { this.logger.warn(`Lock release failed for ${resource}: ${err.message}`); }
    }
  }
}
