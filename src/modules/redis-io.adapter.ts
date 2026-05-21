import { IoAdapter } from '@nestjs/platform-socket.io';
import { INestApplicationContext } from '@nestjs/common';
import { ServerOptions } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';

/**
 * Socket.io adapter that routes events through Redis pub/sub so multiple Nest
 * pods broadcast to the same set of connected clients. Without this, a
 * "bid:new" event emitted from pod-A wouldn't reach a buyer connected to
 * pod-B — critical for live bidding to feel real-time across instances.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor!: ReturnType<typeof createAdapter>;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = Number(process.env.REDIS_PORT) || 6379;
    const password = process.env.REDIS_PASSWORD || undefined;

    const pub = new Redis({ host, port, password, maxRetriesPerRequest: null });
    const sub = pub.duplicate();

    this.adapterConstructor = createAdapter(pub, sub);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, {
      ...options,
      cors: {
        origin: (process.env.CLIENT_ORIGIN || 'http://localhost:3000').split(','),
        credentials: true,
      },
    });
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }
}
