import {
  Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Ip,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { VehiclesService } from './vehicles.service';
import {
  CreateVehicleDto, ListVehiclesQueryDto, UpdateVehicleDto,
} from './vehicles.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public, RequireKyc, Roles } from '../../common/decorators/roles.decorator';

@ApiTags('Vehicles')
@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  // -- Public marketplace endpoints --
  @Public()
  @Get()
  list(@Query() q: ListVehiclesQueryDto) {
    return this.vehicles.list(q);
  }

  @Public()
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.vehicles.findOne(id);
  }

  // -- Bank-only: create / update listing --
  @ApiBearerAuth()
  @Roles(UserRole.BANK_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateVehicleDto) {
    return this.vehicles.create(user, dto);
  }

  @ApiBearerAuth()
  @Roles(UserRole.BANK_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleDto,
  ) {
    return this.vehicles.update(user, id, dto);
  }

  // -- Buyer: click "Buy Now" -> reserve for 10 min --
  // Strict rate limit + KYC requirement. The IP is captured for the fraud
  // sliding window in the service.
  @ApiBearerAuth()
  @Roles(UserRole.BUYER)
  @RequireKyc()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':id/hold')
  hold(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.vehicles.hold(user, id, ip);
  }
}
