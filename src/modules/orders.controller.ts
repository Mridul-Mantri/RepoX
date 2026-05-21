import { Body, Controller, Get, Ip, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { OrdersService } from './orders.service';
import { StartCheckoutDto, VerifyPaymentDto } from './orders.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { RequireKyc, Roles } from '../../common/decorators/roles.decorator';

@ApiTags('Orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Roles(UserRole.BUYER)
  @RequireKyc()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('checkout')
  startCheckout(
    @CurrentUser() user: AuthUser,
    @Body() dto: StartCheckoutDto,
    @Ip() ip: string,
  ) {
    return this.orders.startCheckout(user, dto, ip);
  }

  @Roles(UserRole.BUYER)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post(':id/verify-payment')
  verify(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VerifyPaymentDto,
    @Ip() ip: string,
  ) {
    return this.orders.verifyPayment(user, id, dto, ip);
  }

  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.orders.myOrders(user);
  }

  @Get(':id')
  one(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.getOne(user, id);
  }
}
