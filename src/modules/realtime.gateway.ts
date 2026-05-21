import { Logger } from '@nestjs/common';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect,
  SubscribeMessage, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Rooms:
 *   vehicle:<id>  — bidders watching a single vehicle
 *   lot:<id>      — bulk buyers watching a lot
 *   user:<id>     — that user's private channel (outbid notifications, etc.)
 *   bank:<id>     — bank staff dashboard
 *   admin         — super-admin live feed
 *
 * Any server-side service can `realtime.toRoom('vehicle:abc', 'bid:new', payload)`.
 * Cross-pod fanout is handled by the Redis adapter.
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: '*', credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket) {
    // Optional JWT auth via handshake — anonymous viewers are allowed for
    // public marketplace pages, but actions like bid require a real user.
    const token = client.handshake.auth?.token || client.handshake.headers?.authorization?.toString().replace('Bearer ', '');
    if (token) {
      try {
        const payload: any = this.jwt.verify(token, { secret: this.config.get('JWT_SECRET') });
        const user = await this.prisma.user.findUnique({
          where: { id: payload.sub },
          select: { id: true, role: true, bankId: true },
        });
        if (user) {
          (client as any).user = user;
          client.join(`user:${user.id}`);
          if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') client.join('admin');
          if (user.bankId) client.join(`bank:${user.bankId}`);
        }
      } catch {
        // Bad token → still allow connection as anonymous
      }
    }
    this.logger.debug(`Socket connected: ${client.id} (user=${(client as any).user?.id ?? 'anon'})`);
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Socket disconnected: ${client.id}`);
  }

  @SubscribeMessage('vehicle:watch')
  watchVehicle(@MessageBody() data: { vehicleId: string }, @ConnectedSocket() client: Socket) {
    if (!data?.vehicleId) return { ok: false };
    client.join(`vehicle:${data.vehicleId}`);
    return { ok: true };
  }

  @SubscribeMessage('vehicle:unwatch')
  unwatchVehicle(@MessageBody() data: { vehicleId: string }, @ConnectedSocket() client: Socket) {
    if (!data?.vehicleId) return { ok: false };
    client.leave(`vehicle:${data.vehicleId}`);
    return { ok: true };
  }

  @SubscribeMessage('lot:watch')
  watchLot(@MessageBody() data: { lotId: string }, @ConnectedSocket() client: Socket) {
    if (!data?.lotId) return { ok: false };
    client.join(`lot:${data.lotId}`);
    return { ok: true };
  }

  @SubscribeMessage('lot:unwatch')
  unwatchLot(@MessageBody() data: { lotId: string }, @ConnectedSocket() client: Socket) {
    if (!data?.lotId) return { ok: false };
    client.leave(`lot:${data.lotId}`);
    return { ok: true };
  }
}
