import { Injectable } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Other modules inject this — not the gateway directly — to push events.
 * Keeps the gateway's surface (which is also bound to socket internals) clean.
 */
@Injectable()
export class RealtimeService {
  constructor(private readonly gateway: RealtimeGateway) {}

  toRoom(room: string, event: string, payload: unknown) {
    this.gateway.server?.to(room).emit(event, payload);
  }

  toUser(userId: string, event: string, payload: unknown) {
    this.toRoom(`user:${userId}`, event, payload);
  }

  toAdmins(event: string, payload: unknown) {
    this.toRoom('admin', event, payload);
  }

  toBank(bankId: string, event: string, payload: unknown) {
    this.toRoom(`bank:${bankId}`, event, payload);
  }

  toVehicle(vehicleId: string, event: string, payload: unknown) {
    this.toRoom(`vehicle:${vehicleId}`, event, payload);
  }

  toLot(lotId: string, event: string, payload: unknown) {
    this.toRoom(`lot:${lotId}`, event, payload);
  }

  broadcast(event: string, payload: unknown) {
    this.gateway.server?.emit(event, payload);
  }
}
