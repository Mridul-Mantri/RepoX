import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OrdersService } from './orders.service';

@Injectable()
export class OrdersCronService {
  private readonly logger = new Logger(OrdersCronService.name);

  constructor(private readonly orders: OrdersService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expireOrders() {
    try { await this.orders.expireOverdueOrders(); }
    catch (err: any) { this.logger.error(`Order expiry sweep failed: ${err.message}`); }
  }
}
