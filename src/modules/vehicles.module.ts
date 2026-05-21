import { Module } from '@nestjs/common';
import { VehiclesController } from './vehicles.controller';
import { VehiclesService } from './vehicles.service';
import { HoldsCronService } from './holds-cron.service';

@Module({
  controllers: [VehiclesController],
  providers: [VehiclesService, HoldsCronService],
  exports: [VehiclesService],
})
export class VehiclesModule {}
