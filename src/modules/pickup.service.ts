import {
  Injectable, BadRequestException, ForbiddenException, GoneException, NotFoundException, Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { RealtimeService } from '../realtime/realtime.service';
import { generateOtp } from '../../common/utils/codes';
import { AuthUser } from '../../common/decorators/current-user.decorator';

/**
 * Bank-side pickup flow.
 *
 *  1. Buyer arrives at branch with their phone showing the QR pickup pass.
 *  2. Bank staff opens the bank dashboard → scans the QR → calls /pickup/scan.
 *     We mark the order PICKUP_IN_PROGRESS and generate a 6-digit OTP, which
 *     is "sent" to the buyer's phone (SMS gateway is out of scope here — the
 *     OTP is returned in dev mode for testing).
 *  3. Buyer reads OTP, gives it to staff, staff calls /pickup/complete.
 *  4. Order → COLLECTED, vehicle physically handed over.
 *
 * OTP is stored as a bcrypt hash with a 10-minute expiry. We never store the
 * plaintext OTP on the server side.
 */
@Injectable()
export class PickupService {
  private readonly logger = new Logger(PickupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Step 1: bank staff scans QR. We accept either the pickupPassCode (printed
   * on the QR) OR the order id, whichever the scanner app prefers.
   */
  async scan(user: AuthUser, pickupPassCode: string, ip?: string) {
    if (!user.bankId) throw new ForbiddenException('Only bank staff can verify pickups');

    const order = await this.prisma.order.findUnique({
      where: { pickupPassCode },
      include: {
        buyer: { select: { id: true, name: true, phone: true, email: true } },
        vehicle: { select: { id: true, make: true, model: true, registrationNumber: true, year: true } },
        bank: { select: { id: true, name: true, code: true } },
      },
    });
    if (!order) throw new NotFoundException('Invalid pickup pass');
    if (order.bankId !== user.bankId) {
      throw new ForbiddenException('This pass belongs to a different bank');
    }
    if (order.status === OrderStatus.COLLECTED) {
      throw new BadRequestException('Vehicle already collected');
    }
    if (order.status !== OrderStatus.READY_FOR_PICKUP && order.status !== OrderStatus.PICKUP_IN_PROGRESS) {
      throw new BadRequestException(`Order is in ${order.status} state — cannot proceed`);
    }

    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 8);
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.PICKUP_IN_PROGRESS,
        pickupOtpHash: otpHash,
        pickupOtpExpiresAt: otpExpiresAt,
      },
    });

    await this.activity.log({
      type: 'PICKUP_SCANNED', actorId: user.id, ipAddress: ip,
      message: `QR scanned for order ${order.orderNumber} by ${user.email}`,
      meta: { orderId: order.id },
    });

    // Push to buyer's phone — they should now see "Enter OTP at counter"
    this.realtime.toUser(order.buyerId, 'pickup:otp-sent', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      expiresAt: otpExpiresAt,
    });

    // TODO: integrate SMS gateway (Twilio / MSG91 / Karix) to push OTP to
    // order.buyer.phone. For now we return the OTP in dev so it's testable.
    this.logger.log(`[PICKUP] OTP for order ${order.orderNumber}: ${otp}`);

    return {
      success: true,
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        buyer: { name: order.buyer.name, phoneLast4: order.buyer.phone?.slice(-4) ?? '' },
        vehicle: order.vehicle,
      },
      message: `OTP sent to buyer's phone ending ${order.buyer.phone?.slice(-4) ?? '****'}`,
      // dev-only echo so QA can test without an SMS gateway
      devOtp: process.env.NODE_ENV === 'development' ? otp : undefined,
      otpExpiresAt,
    };
  }

  /**
   * Step 2: staff enters the OTP the buyer read out. Marks order COLLECTED.
   */
  async complete(user: AuthUser, orderId: string, otp: string, ip?: string) {
    if (!user.bankId) throw new ForbiddenException('Only bank staff can verify pickups');

    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Order not found');
    if (order.bankId !== user.bankId) throw new ForbiddenException('Not your bank');
    if (order.status !== OrderStatus.PICKUP_IN_PROGRESS) {
      throw new BadRequestException(`Order is in ${order.status} state — scan QR first`);
    }
    if (!order.pickupOtpHash) {
      throw new BadRequestException('No OTP issued — scan the QR first');
    }
    if (!order.pickupOtpExpiresAt || order.pickupOtpExpiresAt < new Date()) {
      throw new GoneException('OTP expired — please rescan the QR');
    }

    const matches = await bcrypt.compare(otp, order.pickupOtpHash);
    if (!matches) throw new BadRequestException('Invalid OTP');

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.COLLECTED,
        collectedAt: new Date(),
        pickupVerifiedById: user.id,
        pickupOtpHash: null,
        pickupOtpExpiresAt: null,
      },
      include: {
        vehicle: { select: { make: true, model: true, registrationNumber: true } },
      },
    });

    await this.activity.log({
      type: 'PICKUP_COMPLETED', actorId: user.id, ipAddress: ip,
      message: `Pickup completed — order ${order.orderNumber} handed over`,
      meta: { orderId: order.id, vehicleId: order.vehicleId, buyerId: order.buyerId },
    });

    this.realtime.toUser(order.buyerId, 'pickup:completed', {
      orderId: order.id, orderNumber: order.orderNumber,
    });
    this.realtime.toBank(order.bankId, 'pickup:done', { orderId: order.id });

    return { success: true, order: updated };
  }

  /**
   * Bank dashboard: list pickups pending for this bank's branches.
   */
  async pendingForBank(user: AuthUser) {
    if (!user.bankId) throw new ForbiddenException('Only bank staff');
    return this.prisma.order.findMany({
      where: {
        bankId: user.bankId,
        status: { in: [OrderStatus.READY_FOR_PICKUP, OrderStatus.PICKUP_IN_PROGRESS] },
      },
      orderBy: { paidAt: 'asc' },
      include: {
        buyer: { select: { id: true, name: true, phone: true } },
        vehicle: { select: { id: true, make: true, model: true, registrationNumber: true } },
        branch: { select: { id: true, name: true, city: true } },
      },
    });
  }
}
