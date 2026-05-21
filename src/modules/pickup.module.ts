import { Module } from '@nestjs/common';
import { PickupController } from './pickup.controller';
import { PickupService } from './pickup.service';
import { QrService } from './qr.service';

@Module({
  controllers: [PickupController],
  providers: [PickupService, QrService],
  exports: [QrService, PickupService],
})
export class PickupModule {}
