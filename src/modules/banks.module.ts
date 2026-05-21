import {
  Body, Controller, Get, Module, Param, ParseUUIDPipe, Patch, Post, Query,
  Injectable, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray, IsBoolean, IsOptional, IsString, MaxLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public, Roles } from '../../common/decorators/roles.decorator';

// ---- DTOs ------------------------------------------------------------------

class BranchInput {
  @IsString() @MaxLength(80) name!: string;
  @IsString() city!: string;
  @IsString() state!: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() contactPhone?: string;
  @IsOptional() @IsString() managerName?: string;
}

class CreateBankDto {
  @IsString() @MaxLength(120) name!: string;
  @IsString() @MaxLength(10) code!: string;
  @IsOptional() @IsString() logoUrl?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() gstin?: string;
  @IsOptional() @IsString() pan?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => BranchInput)
  branches?: BranchInput[];
}

class UpdateBankDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() logoUrl?: string;
  @IsOptional() @IsBoolean() isVerified?: boolean;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// ---- Service ---------------------------------------------------------------

@Injectable()
class BanksService {
  constructor(private readonly prisma: PrismaService) {}

  list(opts: { onlyActive?: string }) {
    return this.prisma.bank.findMany({
      where: opts.onlyActive === 'true' ? { isActive: true } : {},
      orderBy: { name: 'asc' },
      select: {
        id: true, name: true, code: true, logoUrl: true, type: true,
        isVerified: true, vehiclesListed: true, vehiclesSold: true,
        totalRecoveredPaise: true,
        _count: { select: { vehicles: true } },
      },
    });
  }

  async findOne(id: string) {
    const bank = await this.prisma.bank.findUnique({
      where: { id },
      include: { branches: { where: { isActive: true } } },
    });
    if (!bank) throw new NotFoundException('Bank not found');
    return bank;
  }

  create(dto: CreateBankDto) {
    return this.prisma.bank.create({
      data: {
        name: dto.name,
        code: dto.code.toUpperCase(),
        logoUrl: dto.logoUrl,
        type: dto.type ?? 'BANK',
        gstin: dto.gstin,
        pan: dto.pan,
        branches: dto.branches?.length
          ? { create: dto.branches.map(b => ({ ...b })) }
          : undefined,
      },
      include: { branches: true },
    });
  }

  update(id: string, dto: UpdateBankDto) {
    return this.prisma.bank.update({ where: { id }, data: dto });
  }

  /**
   * Bank dashboard — high-level stats for the staff dashboard.
   */
  async dashboard(user: AuthUser) {
    if (!user.bankId) throw new ForbiddenException('Not a bank user');
    const bankId = user.bankId;

    const [
      bank,
      liveCount, soldCount, pendingPickup, todayBids,
      recentOrders, recentBids,
    ] = await Promise.all([
      this.prisma.bank.findUnique({ where: { id: bankId } }),
      this.prisma.vehicle.count({ where: { bankId, status: 'LIVE' } }),
      this.prisma.vehicle.count({ where: { bankId, status: 'SOLD' } }),
      this.prisma.order.count({
        where: { bankId, status: { in: ['READY_FOR_PICKUP', 'PICKUP_IN_PROGRESS'] } },
      }),
      this.prisma.bid.count({
        where: {
          vehicle: { bankId },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
      this.prisma.order.findMany({
        where: { bankId }, orderBy: { createdAt: 'desc' }, take: 10,
        include: {
          vehicle: { select: { make: true, model: true, registrationNumber: true } },
          buyer: { select: { name: true } },
        },
      }),
      this.prisma.bid.findMany({
        where: { vehicle: { bankId } }, orderBy: { createdAt: 'desc' }, take: 10,
        include: {
          vehicle: { select: { make: true, model: true } },
          bidder: { select: { name: true } },
        },
      }),
    ]);

    return {
      bank,
      counts: { live: liveCount, sold: soldCount, pendingPickup, bids24h: todayBids },
      recentOrders, recentBids,
    };
  }
}

// ---- Controller ------------------------------------------------------------

@ApiTags('Banks')
@Controller('banks')
class BanksController {
  constructor(private readonly banks: BanksService) {}

  @Public()
  @Get()
  list(@Query('onlyActive') onlyActive?: string) {
    return this.banks.list({ onlyActive });
  }

  @Public()
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.banks.findOne(id);
  }

  @ApiBearerAuth()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post()
  create(@Body() dto: CreateBankDto) {
    return this.banks.create(dto);
  }

  @ApiBearerAuth()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBankDto) {
    return this.banks.update(id, dto);
  }

  @ApiBearerAuth()
  @Roles(UserRole.BANK_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Get('me/dashboard')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.banks.dashboard(user);
  }
}

// ---- Module ----------------------------------------------------------------

@Module({
  controllers: [BanksController],
  providers: [BanksService],
  exports: [BanksService],
})
export class BanksModule {}
