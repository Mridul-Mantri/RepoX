import { Body, Controller, Get, Ip, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { BidsService } from './bids.service';
import { PlaceBidDto } from './bids.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public, RequireKyc, Roles } from '../../common/decorators/roles.decorator';

@ApiTags('Bids')
@ApiBearerAuth()
@Controller('bids')
export class BidsController {
  constructor(private readonly bids: BidsService) {}

  // Bid placement is hot — strict per-user-IP throttling on top of the
  // service-level fraud sliding window.
  @Roles(UserRole.BUYER)
  @RequireKyc()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('vehicle/:vehicleId')
  bidOnVehicle(
    @CurrentUser() user: AuthUser,
    @Param('vehicleId', ParseUUIDPipe) vehicleId: string,
    @Body() dto: PlaceBidDto,
    @Ip() ip: string,
  ) {
    return this.bids.bidOnVehicle(user, vehicleId, dto.amountPaise, ip);
  }

  @Roles(UserRole.BUYER)
  @RequireKyc()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('lot/:lotId')
  bidOnLot(
    @CurrentUser() user: AuthUser,
    @Param('lotId', ParseUUIDPipe) lotId: string,
    @Body() dto: PlaceBidDto,
    @Ip() ip: string,
  ) {
    return this.bids.bidOnLot(user, lotId, dto.amountPaise, ip);
  }

  @Public()
  @Get('vehicle/:vehicleId')
  history(@Param('vehicleId', ParseUUIDPipe) vehicleId: string) {
    return this.bids.historyForVehicle(vehicleId);
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.bids.myBids(user.id);
  }
}
