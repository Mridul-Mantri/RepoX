import { Body, Controller, Get, Ip, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { PickupService } from './pickup.service';
import { CompletePickupDto, ScanPickupDto } from './pickup.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('Pickup')
@ApiBearerAuth()
@Controller('pickup')
export class PickupController {
  constructor(private readonly pickup: PickupService) {}

  @Roles(UserRole.BANK_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('scan')
  scan(@CurrentUser() user: AuthUser, @Body() dto: ScanPickupDto, @Ip() ip: string) {
    return this.pickup.scan(user, dto.pickupPassCode, ip);
  }

  @Roles(UserRole.BANK_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':orderId/complete')
  complete(
    @CurrentUser() user: AuthUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CompletePickupDto,
    @Ip() ip: string,
  ) {
    return this.pickup.complete(user, orderId, dto.otp, ip);
  }

  @Roles(UserRole.BANK_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('pending')
  pending(@CurrentUser() user: AuthUser) {
    return this.pickup.pendingForBank(user);
  }
}
