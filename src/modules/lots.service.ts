import {
  Injectable, BadRequestException, ConflictException, ForbiddenException, NotFoundException,
} from '@nestjs/common';
import { LotStatus, SaleType, VehicleStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { generateLotNumber } from '../../common/utils/codes';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { CreateLotDto, ListLotsQueryDto } from './lots.dto';

@Injectable()
export class LotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async list(q: ListLotsQueryDto) {
    return this.prisma.lot.findMany({
      where: {
        status: q.status ?? { in: [LotStatus.OPEN, LotStatus.PRIVATE] },
        ...(q.bankId && { bankId: q.bankId }),
        ...(q.region && { region: { contains: q.region, mode: 'insensitive' } }),
      },
      orderBy: { auctionEndAt: 'asc' },
      include: {
        bank: { select: { id: true, name: true, code: true } },
        _count: { select: { vehicles: true, bids: true } },
      },
    });
  }

  async findOne(id: string) {
    const lot = await this.prisma.lot.findUnique({
      where: { id },
      include: {
        bank: { select: { id: true, name: true, code: true } },
        vehicles: {
          select: {
            id: true, make: true, model: true, year: true, registrationNumber: true,
            reservePricePaise: true, images: { take: 1, orderBy: { position: 'asc' } },
          },
        },
      },
    });
    if (!lot) throw new NotFoundException('Lot not found');
    return lot;
  }

  async create(user: AuthUser, dto: CreateLotDto) {
    if (!user.bankId) throw new BadRequestException('Account not linked to a bank');

    // Every vehicle must belong to this bank and be eligible
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        id: { in: dto.vehicleIds },
        bankId: user.bankId,
        status: { notIn: [VehicleStatus.SOLD, VehicleStatus.CANCELLED] },
        lotId: null,
      },
    });
    if (vehicles.length !== dto.vehicleIds.length) {
      throw new BadRequestException('Some vehicles are not eligible (wrong bank, already in a lot, or sold)');
    }

    const stateCode = vehicles[0]?.branchId ? 'IN' : 'IN';
    const lotNumber = generateLotNumber(stateCode);

    const lot = await this.prisma.$transaction(async (tx) => {
      const created = await tx.lot.create({
        data: {
          lotNumber,
          bankId: user.bankId!,
          createdById: user.id,
          title: dto.title,
          description: dto.description,
          category: dto.category,
          region: dto.region,
          yearFrom: dto.yearFrom,
          yearTo: dto.yearTo,
          reservePricePaise: BigInt(dto.reservePricePaise),
          isPrivate: dto.isPrivate ?? false,
          auctionStartAt: dto.auctionStartAt ? new Date(dto.auctionStartAt) : null,
          auctionEndAt: dto.auctionEndAt ? new Date(dto.auctionEndAt) : null,
          vehicleCount: vehicles.length,
          status: dto.isPrivate ? LotStatus.PRIVATE : LotStatus.OPEN,
        },
      });
      // Link the vehicles to the lot and switch their saleType
      await tx.vehicle.updateMany({
        where: { id: { in: dto.vehicleIds } },
        data: { lotId: created.id, saleType: SaleType.LOT },
      });
      return created;
    });

    await this.activity.log({
      type: 'LOT_CREATED', actorId: user.id,
      message: `Lot ${lotNumber} created with ${vehicles.length} vehicles`,
      meta: { lotId: lot.id },
    });

    return lot;
  }

  async requestAccess(user: AuthUser, lotId: string, message?: string) {
    const lot = await this.prisma.lot.findUnique({ where: { id: lotId } });
    if (!lot) throw new NotFoundException('Lot not found');
    if (!lot.isPrivate) throw new BadRequestException('Lot is open — no access request needed');

    try {
      return await this.prisma.lotAccessRequest.create({
        data: { lotId, userId: user.id, message },
      });
    } catch (err: any) {
      if (err.code === 'P2002') throw new ConflictException('You have already requested access');
      throw err;
    }
  }

  async approveBidder(user: AuthUser, lotId: string, userIdToApprove: string) {
    const lot = await this.prisma.lot.findUnique({ where: { id: lotId } });
    if (!lot) throw new NotFoundException('Lot not found');
    const isOwner = user.bankId === lot.bankId;
    const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
    if (!isOwner && !isAdmin) throw new ForbiddenException('Not authorized');

    await this.prisma.$transaction([
      this.prisma.lotApprovedBidder.upsert({
        where: { lotId_userId: { lotId, userId: userIdToApprove } },
        create: { lotId, userId: userIdToApprove },
        update: {},
      }),
      this.prisma.lotAccessRequest.updateMany({
        where: { lotId, userId: userIdToApprove },
        data: { status: 'APPROVED', reviewedAt: new Date() },
      }),
    ]);

    return { success: true };
  }
}
