import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { VehiclesService } from './vehicles.service';

@Injectable()
export class HoldsCronService {
  private readonly logger = new Logger(HoldsCronService.name);

  constructor(private readonly vehicles: VehiclesService) {}

  // Runs every minute. Releases any vehicles whose hold window passed without
  // payment, putting them back on the market.
  @Cron(CronExpression.EVERY_MINUTE)
  async sweepHolds() {
    try {
      const n = await this.vehicles.releaseExpiredHolds();
      if (n > 0) this.logger.log(`Released ${n} expired hold(s)`);
    } catch (err: any) {
      this.logger.error(`Hold sweep failed: ${err.message}`);
    }
  }
}
