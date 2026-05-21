import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { LotsService } from './lots.service';
import { CreateLotDto, ListLotsQueryDto } from './lots.dto';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public, Roles } from '../../common/decorators/roles.decorator';

@ApiTags('Lots')
@Controller('lots')
export class LotsController {
  constructor(private readonly lots: LotsService) {}

  @Public()
  @Get()
  list(@Query() q: ListLotsQueryDto) { return this.lots.list(q); }

  @Public()
  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) { return this.lots.findOne(id); }

  @ApiBearerAuth()
  @Roles(UserRole.BANK_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateLotDto) {
    return this.lots.create(user, dto);
  }

  @ApiBearerAuth()
  @Roles(UserRole.BUYER)
  @Post(':id/request-access')
  request(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { message?: string },
  ) {
    return this.lots.requestAccess(user, id, body?.message);
  }

  @ApiBearerAuth()
  @Roles(UserRole.BANK_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post(':id/approve-bidder/:userId')
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userIdToApprove: string,
  ) {
    return this.lots.approveBidder(user, id, userIdToApprove);
  }
}
