import {
  Body, Controller, Delete, Get, Injectable, Module, Param, ParseUUIDPipe,
  Patch, Post, Query, NotFoundException, ConflictException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray, IsOptional, IsString, MaxLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { KycStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

// ---- DTOs ------------------------------------------------------------------

class KycDocumentInput {
  @IsString() type!: string;            // "PAN" | "AADHAAR" | "GST"
  @IsString() documentUrl!: string;
  @IsOptional() @IsString() documentNumber?: string;
}

class SubmitKycDto {
  @IsOptional() @IsString() pan?: string;
  @IsOptional() @IsString() gstin?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => KycDocumentInput)
  documents!: KycDocumentInput[];
}

class UpdateProfileDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() companyName?: string;
}

// ---- Service ---------------------------------------------------------------

@Injectable()
class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  profile(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, name: true, phone: true, role: true,
        buyerTier: true, companyName: true, gstin: true, pan: true,
        kycStatus: true, kycSubmittedAt: true, kycReviewedAt: true,
        kycRejectionReason: true, emailVerified: true, phoneVerified: true,
        createdAt: true,
        kycDocuments: { select: { id: true, type: true, verifiedAt: true } },
      },
    });
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    return this.prisma.user.update({
      where: { id: userId }, data: dto,
      select: { id: true, name: true, phone: true, companyName: true },
    });
  }

  async submitKyc(userId: string, dto: SubmitKycDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.kycStatus === KycStatus.APPROVED) {
      throw new ConflictException('KYC is already approved');
    }

    await this.prisma.$transaction([
      this.prisma.kycDocument.deleteMany({ where: { userId } }),
      this.prisma.kycDocument.createMany({
        data: dto.documents.map(d => ({ ...d, userId })),
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          pan: dto.pan ?? user.pan,
          gstin: dto.gstin ?? user.gstin,
          kycStatus: KycStatus.PENDING,
          kycSubmittedAt: new Date(),
          kycReviewedAt: null,
          kycRejectionReason: null,
        },
      }),
    ]);

    await this.activity.log({
      type: 'KYC_SUBMITTED', actorId: userId,
      message: `KYC documents submitted (${dto.documents.length})`,
    });

    return { success: true, status: KycStatus.PENDING };
  }

  // Saved vehicles ("watchlist") -------------------------------------------

  async listSaved(userId: string) {
    return this.prisma.savedVehicle.findMany({
      where: { userId },
      include: {
        vehicle: {
          include: {
            images: { take: 1, orderBy: { position: 'asc' } },
            bank: { select: { name: true, code: true } },
          },
        },
      },
      orderBy: { savedAt: 'desc' },
    });
  }

  async save(userId: string, vehicleId: string) {
    try {
      return await this.prisma.savedVehicle.create({ data: { userId, vehicleId } });
    } catch (err: any) {
      if (err.code === 'P2002') return { alreadySaved: true };
      throw err;
    }
  }

  unsave(userId: string, vehicleId: string) {
    return this.prisma.savedVehicle.delete({
      where: { userId_vehicleId: { userId, vehicleId } },
    });
  }

  // Notifications -----------------------------------------------------------

  notifications(userId: string, unreadOnly = false) {
    return this.prisma.notification.findMany({
      where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  markRead(userId: string, id: string) {
    return this.prisma.notification.updateMany({
      where: { id, userId, readAt: null }, data: { readAt: new Date() },
    });
  }

  markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, readAt: null }, data: { readAt: new Date() },
    });
  }
}

// ---- Controller ------------------------------------------------------------

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) { return this.users.profile(user.id); }

  @Patch('me')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user.id, dto);
  }

  @Post('me/kyc')
  submitKyc(@CurrentUser() user: AuthUser, @Body() dto: SubmitKycDto) {
    return this.users.submitKyc(user.id, dto);
  }

  @Get('me/saved')
  listSaved(@CurrentUser() user: AuthUser) { return this.users.listSaved(user.id); }

  @Post('me/saved/:vehicleId')
  save(@CurrentUser() user: AuthUser, @Param('vehicleId', ParseUUIDPipe) vid: string) {
    return this.users.save(user.id, vid);
  }

  @Delete('me/saved/:vehicleId')
  unsave(@CurrentUser() user: AuthUser, @Param('vehicleId', ParseUUIDPipe) vid: string) {
    return this.users.unsave(user.id, vid);
  }

  @Get('me/notifications')
  notifs(@CurrentUser() user: AuthUser, @Query('unread') unread?: string) {
    return this.users.notifications(user.id, unread === 'true');
  }

  @Patch('me/notifications/:id/read')
  read(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.markRead(user.id, id);
  }

  @Patch('me/notifications/read-all')
  readAll(@CurrentUser() user: AuthUser) { return this.users.markAllRead(user.id); }
}

// ---- Module ----------------------------------------------------------------

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
