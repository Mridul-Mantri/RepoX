import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { RfqsService } from './rfqs.service';
import { CreateRfqDto, RespondToRfqDto } from './rfqs.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { RequireKyc, Roles } from '../../common/decorators/roles.decorator';

@ApiTags('RFQs')
@ApiBearerAuth()
@Controller('rfqs')
export class RfqsController {
  constructor(private readonly rfqs: RfqsService) {}

  @Roles(UserRole.BUYER)
  @RequireKyc()
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRfqDto) {
    return this.rfqs.create(user, dto);
  }

  @Roles(UserRole.BUYER)
  @Get('mine')
  mine(@CurrentUser() user: AuthUser) {
    return this.rfqs.mine(user);
  }

  @Roles(UserRole.BANK_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('incoming')
  incoming(@CurrentUser() user: AuthUser) {
    return this.rfqs.incomingForBanks(user);
  }

  @Roles(UserRole.BANK_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post(':id/respond')
  respond(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondToRfqDto,
  ) {
    return this.rfqs.respond(user, id, dto);
  }

  @Roles(UserRole.BUYER)
  @Post(':rfqId/accept/:responseId')
  accept(
    @CurrentUser() user: AuthUser,
    @Param('rfqId', ParseUUIDPipe) rfqId: string,
    @Param('responseId', ParseUUIDPipe) responseId: string,
  ) {
    return this.rfqs.acceptResponse(user, rfqId, responseId);
  }
}
