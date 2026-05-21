import {
  Body, Controller, Get, Injectable, Module, Param, ParseUUIDPipe, Patch,
  Post, Query, NotFoundException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEnum, IsNumber, IsOptional, IsString, MaxLength, Max, Min,
} from 'class-validator';
import {
  BuyerTier, FraudAlertStatus, KycStatus, UserRole, ActivityLevel,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

// ---- DTOs ------------------------------------------------------------------

class ReviewKycDto {
  @IsEnum(KycStatus) status!: KycStatus;            // APPROVED | REJECTED
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class UpdateFeeDto {
  @IsEnum(BuyerTier) tier!: BuyerTier;
  @IsNumber() @Min(0) @Max(100) percent!: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) gstPercent?: number;
}

class ResolveFraudDto {
  @IsEnum(FraudAlertStatus) status!: FraudAlertStatus;
  @IsOptional() @IsString() resolution?: string;
}

// ---- Service ---------------------------------------------------------------

@Injectable()
class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly realtime: RealtimeService,
  ) {}

  // -- Platform-wide analytics --
  async overview() {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      totalUsers, totalBuyers, totalBanks, totalVehicles, liveVehicles, soldVehicles,
      gmv30d, fees30d, ordersToday, openFraudAlerts, pendingKyc,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: UserRole.BUYER } }),
      this.prisma.bank.count({ where: { isActive: true } }),
      this.prisma.vehicle.count(),
      this.prisma.vehicle.count({ where: { status: 'LIVE' } }),
      this.prisma.vehicle.count({ where: { status: 'SOLD' } }),
      this.prisma.order.aggregate({
        where: { status: { in: ['PAID', 'READY_FOR_PICKUP', 'COLLECTED'] }, paidAt: { gte: monthAgo } },
        _sum: { basePricePaise: true },
      }),
      this.prisma.order.aggregate({
        where: { status: { in: ['PAID', 'READY_FOR_PICKUP', 'COLLECTED'] }, paidAt: { gte: monthAgo } },
        _sum: { platformFeePaise: true },
      }),
      this.prisma.order.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.fraudAlert.count({ where: { status: FraudAlertStatus.OPEN } }),
      this.prisma.user.count({ where: { kycStatus: KycStatus.PENDING } }),
    ]);

    return {
      users: { total: totalUsers, buyers: totalBuyers },
      banks: totalBanks,
      vehicles: { total: totalVehicles, live: liveVehicles, sold: soldVehicles },
      gmv30dPaise: (gmv30d._sum.basePricePaise ?? 0n).toString(),
      platformRevenue30dPaise: (fees30d._sum.platformFeePaise ?? 0n).toString(),
      ordersToday,
      pending: { kyc: pendingKyc, fraudAlerts: openFraudAlerts },
    };
  }

  // -- KYC review queue --
  pendingKyc() {
    return this.prisma.user.findMany({
      where: { kycStatus: KycStatus.PENDING },
      orderBy: { kycSubmittedAt: 'asc' },
      select: {
        id: true, email: true, name: true, phone: true, buyerTier: true,
        companyName: true, gstin: true, pan: true, kycSubmittedAt: true,
        kycDocuments: { select: { id: true, type: true, documentUrl: true, documentNumber: true } },
      },
    });
  }

  async reviewKyc(reviewer: AuthUser, userId: string, dto: ReviewKycDto) {
    if (dto.status !== KycStatus.APPROVED && dto.status !== KycStatus.REJECTED) {
      throw new NotFoundException('Review status must be APPROVED or REJECTED');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        kycStatus: dto.status,
        kycReviewedAt: new Date(),
        kycReviewedById: reviewer.id,
        kycRejectionReason: dto.status === KycStatus.REJECTED ? (dto.reason ?? 'Not specified') : null,
      },
    });

    await this.activity.log({
      type: dto.status === KycStatus.APPROVED ? 'KYC_APPROVED' : 'KYC_REJECTED',
      actorId: reviewer.id,
      message: `KYC ${dto.status.toLowerCase()} for ${user.email}`,
      meta: { userId, reason: dto.reason },
    });

    this.realtime.toUser(userId, 'kyc:reviewed', { status: dto.status, reason: dto.reason });

    return updated;
  }

  // -- Fee management --
  listFees() { return this.prisma.feeSetting.findMany({ orderBy: { tier: 'asc' } }); }

  async upsertFee(reviewer: AuthUser, dto: UpdateFeeDto) {
    const row = await this.prisma.feeSetting.upsert({
      where: { tier: dto.tier },
      create: {
        tier: dto.tier, percent: dto.percent,
        gstPercent: dto.gstPercent ?? 18,
        updatedById: reviewer.id,
      },
      update: {
        percent: dto.percent,
        gstPercent: dto.gstPercent ?? undefined,
        updatedById: reviewer.id,
      },
    });
    await this.activity.log({
      type: 'FEE_CHANGED', actorId: reviewer.id,
      message: `Fee for ${dto.tier} set to ${dto.percent}%`,
      meta: { tier: dto.tier, percent: dto.percent },
    });
    return row;
  }

  // -- Fraud alerts --
  listFraudAlerts(opts: { status?: FraudAlertStatus }) {
    return this.prisma.fraudAlert.findMany({
      where: opts.status ? { status: opts.status } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { subject: { select: { id: true, name: true, email: true, role: true } } },
    });
  }

  async resolveFraudAlert(reviewer: AuthUser, id: string, dto: ResolveFraudDto) {
    return this.prisma.fraudAlert.update({
      where: { id },
      data: {
        status: dto.status,
        resolution: dto.resolution,
        reviewedById: reviewer.id,
        reviewedAt: new Date(),
      },
    });
  }

  // -- User management --
  listUsers(q: { role?: UserRole; tier?: BuyerTier; search?: string }) {
    return this.prisma.user.findMany({
      where: {
        ...(q.role && { role: q.role }),
        ...(q.tier && { buyerTier: q.tier }),
        ...(q.search && {
          OR: [
            { email: { contains: q.search, mode: 'insensitive' } },
            { name: { contains: q.search, mode: 'insensitive' } },
            { phone: { contains: q.search } },
            { companyName: { contains: q.search, mode: 'insensitive' } },
          ],
        }),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true, email: true, name: true, phone: true, role: true,
        buyerTier: true, companyName: true, kycStatus: true, isActive: true,
        createdAt: true, lastLoginAt: true,
        bank: { select: { id: true, name: true } },
      },
    });
  }

  async deactivateUser(reviewer: AuthUser, userId: string) {
    const updated = await this.prisma.user.update({
      where: { id: userId }, data: { isActive: false },
    });
    // Kill all refresh tokens for the user immediately
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null }, data: { revokedAt: new Date() },
    });
    await this.activity.log({
      type: 'USER_DEACTIVATED', level: ActivityLevel.WARN, actorId: reviewer.id,
      message: `User ${updated.email} deactivated`, meta: { userId },
    });
    return updated;
  }

  async createBankStaff(_reviewer: AuthUser, body: {
    email: string; name: string; phone?: string; password: string; bankId: string;
  }) {
    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash(body.password, 10);
    return this.prisma.user.create({
      data: {
        email: body.email.toLowerCase(),
        name: body.name,
        phone: body.phone,
        passwordHash,
        role: UserRole.BANK_STAFF,
        bankId: body.bankId,
        kycStatus: KycStatus.APPROVED,
      },
      select: { id: true, email: true, name: true, role: true, bankId: true },
    });
  }
}

// ---- Controller ------------------------------------------------------------

@ApiTags('Admin')
@ApiBearerAuth()
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller('admin')
class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  overview() { return this.admin.overview(); }

  // KYC
  @Get('kyc/pending')
  pendingKyc() { return this.admin.pendingKyc(); }

  @Patch('kyc/:userId')
  reviewKyc(
    @CurrentUser() reviewer: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ReviewKycDto,
  ) {
    return this.admin.reviewKyc(reviewer, userId, dto);
  }

  // Fees
  @Get('fees')
  fees() { return this.admin.listFees(); }

  @Post('fees')
  setFee(@CurrentUser() user: AuthUser, @Body() dto: UpdateFeeDto) {
    return this.admin.upsertFee(user, dto);
  }

  // Fraud
  @Get('fraud-alerts')
  fraud(@Query('status') status?: FraudAlertStatus) {
    return this.admin.listFraudAlerts({ status });
  }

  @Patch('fraud-alerts/:id')
  resolveFraud(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveFraudDto,
  ) {
    return this.admin.resolveFraudAlert(user, id, dto);
  }

  // Users
  @Get('users')
  users(
    @Query('role') role?: UserRole,
    @Query('tier') tier?: BuyerTier,
    @Query('q') search?: string,
  ) {
    return this.admin.listUsers({ role, tier, search });
  }

  @Patch('users/:id/deactivate')
  deactivate(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.admin.deactivateUser(user, id);
  }

  @Post('users/bank-staff')
  createBankStaff(
    @CurrentUser() user: AuthUser,
    @Body() body: { email: string; name: string; phone?: string; password: string; bankId: string },
  ) {
    return this.admin.createBankStaff(user, body);
  }
}

// ---- Module ----------------------------------------------------------------

@Module({
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
