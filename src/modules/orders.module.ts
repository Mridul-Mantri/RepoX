import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersCronService } from './orders-cron.service';
import { FeeService } from './fee.service';
import { PaymentsModule } from '../payments/payments.module';
import { PickupModule } from '../pickup/pickup.module';

@Module({
  imports: [PaymentsModule, PickupModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersCronService, FeeService],
  exports: [OrdersService, FeeService],
})
export class OrdersModule {}
