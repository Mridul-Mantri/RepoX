import {
  Injectable, BadRequestException, ConflictException, ForbiddenException,
  GoneException, NotFoundException, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivityLevel, LotStatus, SaleType, VehicleStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ActivityService } from '../activity/activity.service';
import { Money } from '../../common/utils/money';
import { AuthUser } from '../../common/decorators/current-user.decorator';

/**
 * Bidding is the most concurrency-sensitive surface of the platform. Two
 * bidders may submit equal bids within milliseconds; only one can win.
 *
 * Strategy:
 *  - Redis lock per vehicle / lot ID → serialise concurrent bid attempts.
 *  - Optimistic compare: inside the lock, do an UPDATE that requires
 *    currentBidPaise to equal what we read. If 0 rows matched, throw.
 *  - Bid row is written only after the vehicle row update succeeds.
 *  - Anti-snipe: if a bid lands within ANTI_SNIPE_WINDOW_SECONDS of auctionEndAt,
 *    extend auctionEndAt by ANTI_SNIPE_EXTENSION_SECONDS.
 */
@Injectable()
export class BidsService {
  private readonly logger = new Logger(BidsService.name);
  private readonly minVehicleIncrementPaise: bigint;
  private readonly minLotIncrementPaise: bigint;
  private readonly antiSnipeWindowMs: number;
  private readonly antiSnipeExtensionMs: number;
  private readonly fraudBidThreshold: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly activity: ActivityService,
    config: ConfigService,
  ) {
    // Stored as rupees in env but converted to paise here once.
    this.minVehicleIncrementPaise = BigInt((config.get<number>('AUCTION_MIN_INCREMENT') ?? 1000) * 100);
    this.minLotIncrementPaise = BigInt((config.get<number>('LOT_MIN_INCREMENT') ?? 10_000) * 100);
    this.antiSnipeWindowMs = (config.get<number>('ANTI_SNIPE_WINDOW_SECONDS') ?? 120) * 1000;
    this.antiSnipeExtensionMs = (config.get<number>('ANTI_SNIPE_EXTENSION_SECONDS') ?? 120) * 1000;
    this.fraudBidThreshold = config.get<number>('FRAUD_BID_ATTEMPTS_PER_MIN') ?? 20;
  }

  // ---- VEHICLE bids ----------------------------------------------------------

  async bidOnVehicle(user: AuthUser, vehicleId: string, amountPaiseNum: number, ip?: string) {
    const amountPaise = BigInt(amountPaiseNum);
    if (amountPaise <= 0n) throw new BadRequestException('Bid must be positive');

    // Fraud signal: too many bid attempts in 60s
    const attempts = await this.redis.incrWindow(`fraud:bid:${user.id}`, 60);
    if (attempts > this.fraudBidThreshold) {
      await this.prisma.fraudAlert.create({
        data: {
          type: 'RAPID_BID_ATTEMPTS', subjectId: user.id, ipAddress: ip,
          description: `User attempted ${attempts} bids in 60 seconds`,
          meta: { vehicleId, attempts },
        },
      });
      this.realtime.toAdmins('fraud:alert', { type: 'RAPID_BID_ATTEMPTS', userId: user.id, attempts });
      throw new ConflictException('Too many bid attempts — slow down');
    }

    return this.redis.withLock(`vehicle:${vehicleId}`, 5_000, async () => {
      // Read latest state inside the lock
      const v = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
      if (!v) throw new NotFoundException('Vehicle not found');

      if (![SaleType.AUCTION, SaleType.HYBRID].includes(v.saleType)) {
        throw new BadRequestException('This listing does not accept bids');
      }
      if (v.status !== VehicleStatus.LIVE) {
        throw new ConflictException(`Vehicle status is ${v.status} — bids closed`);
      }
      if (v.auctionEndAt && v.auctionEndAt < new Date()) {
        throw new GoneException('Auction has ended');
      }
      // Banks cannot bid on their own listings
      if (user.role === 'BANK_STAFF' && user.bankId === v.bankId) {
        throw new ForbiddenException('Bank staff cannot bid on their own listings');
      }

      const minRequired =
        v.currentBidPaise > 0n
          ? v.currentBidPaise + this.minVehicleIncrementPaise
          : (v.startingBidPaise ?? v.reservePricePaise);

      if (amountPaise < minRequired) {
        throw new BadRequestException(
          `Bid too low — minimum is ${Money.formatINR(minRequired)}`,
        );
      }

      // Conditional update: must still match the snapshot we read.
      const updateResult = await this.prisma.vehicle.updateMany({
        where: {
          id: vehicleId,
          currentBidPaise: v.currentBidPaise,
          status: VehicleStatus.LIVE,
        },
        data: {
          currentBidPaise: amountPaise,
          currentBidderId: user.id,
          bidCount: { increment: 1 },
        },
      });
      if (updateResult.count === 0) {
        throw new ConflictException('Outbid in flight — please refresh');
      }

      // Mark prior winning bid as not winning, then write the new bid row.
      await this.prisma.$transaction([
        this.prisma.bid.updateMany({
          where: { vehicleId, isWinning: true }, data: { isWinning: false },
        }),
        this.prisma.bid.create({
          data: {
            vehicleId, bidderId: user.id, amountPaise,
            isWinning: true, ipAddress: ip,
          },
        }),
      ]);

      // Anti-snipe: if the bid was inside the last N seconds, extend.
      let newEnd = v.auctionEndAt;
      if (v.auctionEndAt) {
        const msLeft = v.auctionEndAt.getTime() - Date.now();
        if (msLeft > 0 && msLeft < this.antiSnipeWindowMs) {
          newEnd = new Date(Date.now() + this.antiSnipeExtensionMs);
          await this.prisma.vehicle.update({
            where: { id: vehicleId },
            data: { auctionEndAt: newEnd, autoExtendCount: { increment: 1 } },
          });
        }
      }

      // Notify previous winning bidder that they've been outbid
      if (v.currentBidderId && v.currentBidderId !== user.id) {
        this.realtime.toUser(v.currentBidderId, 'bid:outbid', {
          vehicleId, currentBidPaise: amountPaise.toString(),
        });
        await this.prisma.notification.create({
          data: {
            userId: v.currentBidderId, type: 'BID_OUTBID',
            title: `Outbid on ${v.make} ${v.model}`,
            body: `Current bid is now ${Money.formatINR(amountPaise)}`,
            link: `/vehicles/${vehicleId}`,
          },
        });
      }

      await this.activity.log({
        type: 'VEHICLE_BID', actorId: user.id, ipAddress: ip,
        message: `Bid ${Money.formatINR(amountPaise)} placed on ${v.make} ${v.model}`,
        meta: { vehicleId, amountPaise: amountPaise.toString() },
      });

      this.realtime.toVehicle(vehicleId, 'bid:new', {
        vehicleId,
        currentBidPaise: amountPaise.toString(),
        bidderId: user.id,
        bidCount: v.bidCount + 1,
        auctionEndAt: newEnd,
      });

      return {
        success: true,
        vehicleId,
        currentBidPaise: amountPaise.toString(),
        auctionEndAt: newEnd,
      };
    });
  }

  // ---- LOT bids --------------------------------------------------------------

  async bidOnLot(user: AuthUser, lotId: string, amountPaiseNum: number, ip?: string) {
    const amountPaise = BigInt(amountPaiseNum);
    if (amountPaise <= 0n) throw new BadRequestException('Bid must be positive');

    return this.redis.withLock(`lot:${lotId}`, 5_000, async () => {
      const lot = await this.prisma.lot.findUnique({
        where: { id: lotId },
        include: { approvedBidders: { where: { userId: user.id } } },
      });
      if (!lot) throw new NotFoundException('Lot not found');
      if (![LotStatus.OPEN, LotStatus.PRIVATE].includes(lot.status)) {
        throw new ConflictException('Lot is not open for bidding');
      }
      if (lot.auctionEndAt && lot.auctionEndAt < new Date()) {
        throw new GoneException('Lot auction ended');
      }
      if (lot.isPrivate && lot.approvedBidders.length === 0) {
        throw new ForbiddenException('You are not approved to bid on this private lot');
      }
      if (user.role === 'BANK_STAFF' && user.bankId === lot.bankId) {
        throw new ForbiddenException('Bank staff cannot bid on their own lots');
      }

      const minRequired = lot.currentBidPaise > 0n
        ? lot.currentBidPaise + this.minLotIncrementPaise
        : lot.reservePricePaise;
      if (amountPaise < minRequired) {
        throw new BadRequestException(`Lot bid too low — minimum ${Money.formatINR(minRequired)}`);
      }

      const updateResult = await this.prisma.lot.updateMany({
        where: { id: lotId, currentBidPaise: lot.currentBidPaise },
        data: {
          currentBidPaise: amountPaise,
          currentBidderId: user.id,
          bidCount: { increment: 1 },
        },
      });
      if (updateResult.count === 0) throw new ConflictException('Outbid — please refresh');

      await this.prisma.$transaction([
        this.prisma.bid.updateMany({
          where: { lotId, isWinning: true }, data: { isWinning: false },
        }),
        this.prisma.bid.create({
          data: { lotId, bidderId: user.id, amountPaise, isWinning: true, ipAddress: ip },
        }),
      ]);

      let newEnd = lot.auctionEndAt;
      if (lot.auctionEndAt) {
        const msLeft = lot.auctionEndAt.getTime() - Date.now();
        if (msLeft > 0 && msLeft < this.antiSnipeWindowMs) {
          newEnd = new Date(Date.now() + this.antiSnipeExtensionMs);
          await this.prisma.lot.update({ where: { id: lotId }, data: { auctionEndAt: newEnd } });
        }
      }

      if (lot.currentBidderId && lot.currentBidderId !== user.id) {
        this.realtime.toUser(lot.currentBidderId, 'lot:outbid', { lotId });
      }

      await this.activity.log({
        type: 'LOT_BID', actorId: user.id, ipAddress: ip,
        message: `Lot bid ${Money.formatINR(amountPaise)} on ${lot.lotNumber}`,
        meta: { lotId, amountPaise: amountPaise.toString() },
      });

      this.realtime.toLot(lotId, 'lot-bid:new', {
        lotId,
        currentBidPaise: amountPaise.toString(),
        bidCount: lot.bidCount + 1,
        auctionEndAt: newEnd,
      });

      return { success: true, lotId, currentBidPaise: amountPaise.toString(), auctionEndAt: newEnd };
    });
  }

  // ---- Reads -----------------------------------------------------------------

  async historyForVehicle(vehicleId: string) {
    return this.prisma.bid.findMany({
      where: { vehicleId },
      orderBy: { amountPaise: 'desc' },
      take: 50,
      include: { bidder: { select: { id: true, name: true, buyerTier: true } } },
    });
  }

  async myBids(userId: string) {
    return this.prisma.bid.findMany({
      where: { bidderId: userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        vehicle: { select: { id: true, make: true, model: true, registrationNumber: true, currentBidPaise: true, status: true } },
        lot: { select: { id: true, lotNumber: true, title: true, currentBidPaise: true, status: true } },
      },
    });
  }
}
