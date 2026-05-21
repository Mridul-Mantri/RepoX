import {
  Injectable, NotFoundException, BadRequestException,
  ConflictException, ForbiddenException, GoneException, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, VehicleStatus, SaleType, ActivityLevel } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ActivityService } from '../activity/activity.service';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { CreateVehicleDto, ListVehiclesQueryDto, UpdateVehicleDto } from './vehicles.dto';

@Injectable()
export class VehiclesService {
  private readonly logger = new Logger(VehiclesService.name);
  private readonly holdMinutes: number;
  private readonly fraudHoldThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly activity: ActivityService,
    config: ConfigService,
  ) {
    this.holdMinutes = config.get<number>('HOLD_MINUTES') ?? 10;
    this.fraudHoldThreshold = config.get<number>('FRAUD_HOLD_ATTEMPTS_PER_MIN') ?? 5;
  }

  // ---- Public marketplace listing -------------------------------------------

  async list(q: ListVehiclesQueryDto) {
    const where: Prisma.VehicleWhereInput = {
      status: { in: [VehicleStatus.LIVE, VehicleStatus.ON_HOLD] },
      ...(q.saleType && { saleType: q.saleType }),
      ...(q.category && { category: q.category }),
      ...(q.fuelType && { fuelType: q.fuelType }),
      ...(q.bankId && { bankId: q.bankId }),
      ...(q.city && { branch: { is: { city: { equals: q.city, mode: 'insensitive' } } } }),
      ...((q.minPricePaise || q.maxPricePaise) && {
        reservePricePaise: {
          ...(q.minPricePaise ? { gte: BigInt(q.minPricePaise) } : {}),
          ...(q.maxPricePaise ? { lte: BigInt(q.maxPricePaise) } : {}),
        },
      }),
      ...(q.q && {
        OR: [
          { make: { contains: q.q, mode: 'insensitive' } },
          { model: { contains: q.q, mode: 'insensitive' } },
          { registrationNumber: { contains: q.q.toUpperCase() } },
        ],
      }),
    };

    const orderBy: Prisma.VehicleOrderByWithRelationInput =
      q.sort === 'price_asc'  ? { reservePricePaise: 'asc' }
    : q.sort === 'price_desc' ? { reservePricePaise: 'desc' }
    : q.sort === 'newest'     ? { createdAt: 'desc' }
    :                           { auctionEndAt: 'asc' };

    const page = q.page ?? 1;
    const limit = q.limit ?? 12;
    const skip = (page - 1) * limit;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.vehicle.findMany({
        where, orderBy, skip, take: limit,
        include: {
          bank: { select: { id: true, name: true, code: true, logoUrl: true } },
          branch: { select: { id: true, name: true, city: true } },
          images: { orderBy: { position: 'asc' }, take: 1 },
        },
      }),
      this.prisma.vehicle.count({ where }),
    ]);

    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findOne(id: string) {
    const v = await this.prisma.vehicle.findUnique({
      where: { id },
      include: {
        bank: { select: { id: true, name: true, code: true, logoUrl: true, branches: true } },
        branch: true,
        images: { orderBy: { position: 'asc' } },
        listedBy: { select: { id: true, name: true } },
      },
    });
    if (!v) throw new NotFoundException('Vehicle not found');
    // Fire-and-forget watcher counter
    this.prisma.vehicle.update({ where: { id }, data: { watcherCount: { increment: 1 } } }).catch(() => {});
    return v;
  }

  // ---- Bank-side mutations ---------------------------------------------------

  async create(user: AuthUser, dto: CreateVehicleDto) {
    if (!user.bankId) throw new BadRequestException('Your account is not linked to a bank');

    // Validate the bank-verified flag once so we know the initial status.
    const bank = await this.prisma.bank.findUnique({ where: { id: user.bankId } });
    if (!bank) throw new NotFoundException('Bank not found');

    const initialStatus = bank.isVerified ? VehicleStatus.LIVE : VehicleStatus.PENDING_APPROVAL;

    const vehicle = await this.prisma.vehicle.create({
      data: {
        bankId: bank.id,
        branchId: dto.branchId,
        listedById: user.id,
        registrationNumber: dto.registrationNumber.toUpperCase(),
        make: dto.make, model: dto.model, variant: dto.variant,
        year: dto.year, color: dto.color, category: dto.category,
        fuelType: dto.fuelType, transmission: dto.transmission,
        kmDriven: dto.kmDriven ?? 0, ownerCount: dto.ownerCount ?? 1,
        insuranceValidTill: dto.insuranceValidTill ? new Date(dto.insuranceValidTill) : null,
        rcAvailable: dto.rcAvailable ?? true,
        condition: dto.condition,
        inspectionNotes: dto.inspectionNotes,
        inspectionReportUrl: dto.inspectionReportUrl,
        saleType: dto.saleType,
        reservePricePaise: BigInt(dto.reservePricePaise),
        buyNowPricePaise: dto.buyNowPricePaise ? BigInt(dto.buyNowPricePaise) : null,
        startingBidPaise: dto.startingBidPaise ? BigInt(dto.startingBidPaise) : null,
        auctionStartAt: dto.auctionStartAt ? new Date(dto.auctionStartAt) : null,
        auctionEndAt: dto.auctionEndAt ? new Date(dto.auctionEndAt) : null,
        status: initialStatus,
        images: dto.imageUrls?.length
          ? { create: dto.imageUrls.map((url, i) => ({ url, position: i, isPrimary: i === 0 })) }
          : undefined,
      },
      include: { images: true },
    });

    await this.prisma.bank.update({
      where: { id: bank.id }, data: { vehiclesListed: { increment: 1 } },
    });

    await this.activity.log({
      type: 'VEHICLE_LISTED', actorId: user.id,
      message: `Vehicle listed — ${vehicle.make} ${vehicle.model} (${vehicle.registrationNumber})`,
      meta: { vehicleId: vehicle.id, bankId: bank.id },
    });

    return vehicle;
  }

  async update(user: AuthUser, id: string, dto: UpdateVehicleDto) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    const isOwner = user.bankId === vehicle.bankId;
    const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
    if (!isOwner && !isAdmin) throw new ForbiddenException('Not authorized');

    // Once any bid is placed, financial fields are frozen
    if (vehicle.bidCount > 0) {
      delete (dto as any).reservePricePaise;
      delete (dto as any).buyNowPricePaise;
    }

    return this.prisma.vehicle.update({
      where: { id },
      data: {
        ...dto,
        reservePricePaise: dto.reservePricePaise ? BigInt(dto.reservePricePaise) : undefined,
        buyNowPricePaise: dto.buyNowPricePaise ? BigInt(dto.buyNowPricePaise) : undefined,
        auctionEndAt: dto.auctionEndAt ? new Date(dto.auctionEndAt) : undefined,
      },
    });
  }

  // ---- THE HOLD: Buyer clicks "Buy Now" -------------------------------------

  /**
   * Reserve a vehicle for `user` for HOLD_MINUTES minutes.
   *
   * Concurrency strategy (defence in depth):
   *  1. Sliding-window fraud check  — if the user attempts many holds per
   *     minute, raise a fraud alert and reject.
   *  2. Redis distributed lock      — prevents two API pods from simultaneously
   *     reading "status=LIVE" and both writing "ON_HOLD".
   *  3. Postgres conditional update — inside the lock, we UPDATE with a WHERE
   *     clause that requires status=LIVE OR status=ON_HOLD-with-expired-hold.
   *     If 0 rows are affected, someone else got it. This is the source of
   *     truth.
   *  4. Activity log + realtime push — admins see it live, the room sees the
   *     vehicle's new state.
   */
  async hold(user: AuthUser, vehicleId: string, ip?: string) {
    // --- (1) Fraud signal: too many holds in 60s
    const attempts = await this.redis.incrWindow(`fraud:hold:${user.id}`, 60);
    if (attempts > this.fraudHoldThreshold) {
      await this.prisma.fraudAlert.create({
        data: {
          type: 'RAPID_HOLD_ATTEMPTS',
          subjectId: user.id,
          ipAddress: ip,
          description: `User attempted ${attempts} holds in 60 seconds`,
          meta: { vehicleId, attempts },
        },
      });
      await this.activity.log({
        type: 'FRAUD_ALERT', level: ActivityLevel.WARN, actorId: user.id, ipAddress: ip,
        message: `Suspicious — ${attempts} rapid hold attempts`,
        meta: { vehicleId, attempts },
      });
      this.realtime.toAdmins('fraud:alert', { type: 'RAPID_HOLD_ATTEMPTS', userId: user.id, attempts });
      throw new ConflictException('Too many hold attempts — try again later');
    }

    // --- (2) + (3) Lock + atomic state transition
    const lockTtl = 5_000; // 5s is plenty for one DB write
    return this.redis.withLock(`vehicle:${vehicleId}`, lockTtl, async () => {
      const now = new Date();
      const heldUntil = new Date(Date.now() + this.holdMinutes * 60 * 1000);

      // Atomic conditional update: succeed only if vehicle is LIVE, or it's
      // ON_HOLD but the hold window has already expired.
      const result = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.vehicle.updateMany({
          where: {
            id: vehicleId,
            saleType: { in: [SaleType.BUY_NOW, SaleType.HYBRID] },
            OR: [
              { status: VehicleStatus.LIVE },
              { status: VehicleStatus.ON_HOLD, heldUntil: { lt: now } },
            ],
          },
          data: {
            status: VehicleStatus.ON_HOLD,
            heldById: user.id,
            heldUntil,
            lockVersion: { increment: 1 },
          },
        });

        if (updated.count === 0) {
          // Diagnose why so we can return a clean error
          const v = await tx.vehicle.findUnique({ where: { id: vehicleId } });
          if (!v) throw new NotFoundException('Vehicle not found');
          if (v.status === VehicleStatus.SOLD) throw new GoneException('Vehicle already sold');
          if (v.saleType === SaleType.AUCTION) {
            throw new BadRequestException('This is an auction-only listing — place a bid instead');
          }
          throw new ConflictException('Vehicle is currently held by another buyer');
        }

        return tx.vehicle.findUnique({
          where: { id: vehicleId },
          include: { bank: { select: { id: true, name: true, code: true } } },
        });
      });

      // --- (4) Side effects (outside the DB transaction, inside the lock)
      await this.activity.log({
        type: 'VEHICLE_HELD', actorId: user.id, ipAddress: ip,
        message: `Vehicle held — ${result!.registrationNumber} reserved for ${this.holdMinutes} min`,
        meta: { vehicleId, heldUntil },
      });

      this.realtime.toVehicle(vehicleId, 'vehicle:held', {
        vehicleId, heldUntil, heldById: user.id,
      });
      this.realtime.toUser(user.id, 'order:hold-created', { vehicleId, heldUntil });

      return {
        vehicle: result,
        heldUntil,
        holdMinutes: this.holdMinutes,
        // The buyer must hit POST /orders/checkout before this deadline.
        nextStep: 'CALL /orders/checkout',
      };
    });
  }

  /**
   * Periodic sweep: release any vehicles whose hold has elapsed without
   * payment. Called by HoldsCronService once per minute.
   */
  async releaseExpiredHolds(): Promise<number> {
    const now = new Date();
    const expired = await this.prisma.vehicle.findMany({
      where: { status: VehicleStatus.ON_HOLD, heldUntil: { lt: now } },
      select: { id: true, registrationNumber: true, heldById: true },
    });
    if (expired.length === 0) return 0;

    // Bulk release in one go
    await this.prisma.vehicle.updateMany({
      where: { id: { in: expired.map(v => v.id) } },
      data: { status: VehicleStatus.LIVE, heldById: null, heldUntil: null },
    });

    for (const v of expired) {
      this.realtime.toVehicle(v.id, 'vehicle:hold-expired', { vehicleId: v.id });
      if (v.heldById) this.realtime.toUser(v.heldById, 'order:hold-expired', { vehicleId: v.id });
      await this.activity.log({
        type: 'HOLD_EXPIRED', level: ActivityLevel.WARN,
        message: `Hold expired — vehicle ${v.registrationNumber} released to LIVE`,
        meta: { vehicleId: v.id, prevHeldById: v.heldById },
      });
    }
    return expired.length;
  }
}
