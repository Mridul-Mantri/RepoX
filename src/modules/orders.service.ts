import {
  Injectable, BadRequestException, ForbiddenException, GoneException, NotFoundException,
  ConflictException, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OrderStatus, PaymentStatus, SaleType, VehicleStatus, ActivityLevel,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ActivityService } from '../activity/activity.service';
import { FeeService } from './fee.service';
import { RazorpayService } from '../payments/razorpay.service';
import { QrService } from '../pickup/qr.service';
import { Money } from '../../common/utils/money';
import { generatePickupPass } from '../../common/utils/codes';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { StartCheckoutDto, VerifyPaymentDto } from './orders.dto';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly holdMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
    private readonly activity: ActivityService,
    private readonly fees: FeeService,
    private readonly razorpay: RazorpayService,
    private readonly qr: QrService,
    config: ConfigService,
  ) {
    this.holdMinutes = config.get<number>('HOLD_MINUTES') ?? 10;
  }

  /**
   * POST /orders/checkout
   *
   * Caller must already be either:
   *   (a) the user holding the vehicle (set by POST /vehicles/:id/hold), or
   *   (b) the winning bidder of an auction whose end time has passed.
   *
   * Creates: Order (HELD) → Razorpay Order → Payment (INITIATED).
   * Returns the Razorpay order info for the frontend to launch the checkout.
   */
  async startCheckout(user: AuthUser, dto: StartCheckoutDto, ip?: string) {
    return this.redis.withLock(`vehicle:${dto.vehicleId}`, 5_000, async () => {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: dto.vehicleId },
        include: { bank: true },
      });
      if (!vehicle) throw new NotFoundException('Vehicle not found');

      // Determine the base price + entitlement gate
      let basePricePaise: bigint;
      if (vehicle.saleType === SaleType.BUY_NOW || vehicle.saleType === SaleType.HYBRID) {
        if (vehicle.heldById !== user.id) {
          throw new ForbiddenException('This vehicle is not held for you — click Buy Now first');
        }
        if (vehicle.heldUntil && vehicle.heldUntil < new Date()) {
          throw new GoneException('Your hold has expired — start over');
        }
        if (!vehicle.buyNowPricePaise) {
          throw new BadRequestException('Buy-now price not set');
        }
        basePricePaise = vehicle.buyNowPricePaise;
      } else if (vehicle.saleType === SaleType.AUCTION) {
        if (!vehicle.auctionEndAt || vehicle.auctionEndAt > new Date()) {
          throw new BadRequestException('Auction has not ended yet');
        }
        if (vehicle.currentBidderId !== user.id) {
          throw new ForbiddenException('You are not the winning bidder');
        }
        basePricePaise = vehicle.currentBidPaise;
      } else {
        throw new BadRequestException('Lot purchases use a different checkout flow');
      }

      // Prevent duplicate checkouts for the same vehicle by the same user
      const existing = await this.prisma.order.findFirst({
        where: {
          vehicleId: vehicle.id,
          buyerId: user.id,
          status: { in: [OrderStatus.HELD, OrderStatus.PAYMENT_PENDING, OrderStatus.PAID, OrderStatus.READY_FOR_PICKUP] },
        },
      });
      if (existing) {
        throw new ConflictException(`Order ${existing.orderNumber} already in progress for this vehicle`);
      }

      // Compute totals
      const { feePercent, gstPercent } = await this.fees.getFeeForTier(user.buyerTier ?? 'RETAIL' as any);
      const totals = Money.computeOrderTotals(basePricePaise, feePercent, gstPercent);

      // Pickup pass = order number (one identifier, easier to debug)
      const orderNumber = generatePickupPass();
      const heldUntil = vehicle.heldUntil ?? new Date(Date.now() + this.holdMinutes * 60 * 1000);

      // Wrap order + payment in a DB transaction
      const { order, payment, rzOrder } = await this.prisma.$transaction(async (tx) => {
        const created = await tx.order.create({
          data: {
            orderNumber,
            buyerId: user.id,
            bankId: vehicle.bankId,
            branchId: vehicle.branchId,
            vehicleId: vehicle.id,
            saleType: vehicle.saleType,
            basePricePaise: totals.basePricePaise,
            platformFeePercent: totals.platformFeePercent,
            platformFeePaise: totals.platformFeePaise,
            gstPercent: totals.gstPercent,
            gstOnFeePaise: totals.gstOnFeePaise,
            totalAmountPaise: totals.totalAmountPaise,
            status: OrderStatus.HELD,
            heldUntil,
            pickupPassCode: orderNumber,
          },
        });

        // Create Razorpay order (network call — but tolerable inside tx; if it
        // fails the whole transaction rolls back and the vehicle stays held
        // for the buyer to retry).
        const rzOrder = await this.razorpay.createOrder({
          amountPaise: totals.totalAmountPaise,
          receipt: orderNumber,
          notes: {
            orderId: created.id,
            buyerId: user.id,
            vehicleReg: vehicle.registrationNumber,
          },
        });

        const payment = await tx.payment.create({
          data: {
            orderId: created.id,
            amountPaise: totals.totalAmountPaise,
            method: dto.method,
            upiId: dto.upiId,
            razorpayOrderId: rzOrder.id,
            status: PaymentStatus.INITIATED,
          },
        });

        return { order: created, payment, rzOrder };
      });

      await this.activity.log({
        type: 'ORDER_CHECKOUT_STARTED', actorId: user.id, ipAddress: ip,
        message: `Checkout started — order ${order.orderNumber} (${Money.formatINR(totals.totalAmountPaise)})`,
        meta: { orderId: order.id, vehicleId: vehicle.id, paymentId: payment.id },
      });

      this.realtime.toUser(user.id, 'order:created', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        heldUntil,
      });

      return {
        order: { ...order, _payment: payment },
        razorpay: {
          orderId: rzOrder.id,
          amount: rzOrder.amount,
          currency: rzOrder.currency,
          keyId: this.razorpay.publicKeyId,
          mock: !!(rzOrder as any)._mock,
        },
      };
    });
  }

  /**
   * POST /orders/:id/verify-payment
   * Called by the frontend after Razorpay returns success. We verify the HMAC
   * signature, mark order PAID, generate QR pickup pass, mark vehicle SOLD,
   * update bank stats — all in one transaction.
   */
  async verifyPayment(user: AuthUser, orderId: string, dto: VerifyPaymentDto, ip?: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { vehicle: true, bank: true, payments: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.buyerId !== user.id) throw new ForbiddenException('Not your order');

    if (order.status === OrderStatus.EXPIRED) throw new GoneException('Order expired');
    if (order.status === OrderStatus.PAID || order.status === OrderStatus.READY_FOR_PICKUP) {
      return { success: true, alreadyPaid: true, order };
    }

    // Find the matching payment row
    const payment = order.payments.find((p) =>
      p.razorpayOrderId && [PaymentStatus.INITIATED, PaymentStatus.AUTHORIZED].includes(p.status),
    );
    if (!payment) throw new BadRequestException('No pending payment to verify');

    const valid = this.razorpay.verifyPaymentSignature({
      razorpayOrderId: payment.razorpayOrderId!,
      razorpayPaymentId: dto.razorpayPaymentId,
      razorpaySignature: dto.razorpaySignature,
    });

    if (!valid) {
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED, failureReason: 'Signature mismatch' },
      });
      await this.prisma.fraudAlert.create({
        data: {
          type: 'PAYMENT_SIGNATURE_MISMATCH',
          subjectId: user.id,
          ipAddress: ip,
          description: `Payment signature mismatch on order ${order.orderNumber}`,
          meta: { orderId: order.id, paymentId: payment.id },
        },
      });
      await this.activity.log({
        type: 'PAYMENT_FAILED', level: ActivityLevel.ERROR, actorId: user.id,
        message: `Payment signature mismatch on order ${order.orderNumber}`,
        ipAddress: ip,
      });
      this.realtime.toAdmins('fraud:alert', { type: 'PAYMENT_SIGNATURE_MISMATCH', orderId: order.id });
      throw new BadRequestException('Payment signature verification failed');
    }

    // Generate the QR up-front (outside the DB tx, network-ish)
    const qrDataUrl = await this.qr.generatePickupQr({
      orderNumber: order.orderNumber,
      buyerId: user.id,
      vehicleId: order.vehicleId,
      bankCode: order.bank.code,
    });

    // Single transaction: payment captured + order ready + vehicle sold + bank stats
    const result = await this.prisma.$transaction(async (tx) => {
      const paymentUpdated = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.CAPTURED,
          razorpayPaymentId: dto.razorpayPaymentId,
          razorpaySignature: dto.razorpaySignature,
          capturedAt: new Date(),
        },
      });

      const orderUpdated = await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.READY_FOR_PICKUP,
          paidAt: new Date(),
          qrCodeDataUrl: qrDataUrl,
        },
      });

      if (order.vehicleId) {
        await tx.vehicle.update({
          where: { id: order.vehicleId },
          data: {
            status: VehicleStatus.SOLD,
            soldToId: user.id,
            soldAt: new Date(),
            soldPricePaise: order.basePricePaise,
            heldById: null,
            heldUntil: null,
          },
        });

        await tx.bank.update({
          where: { id: order.bankId },
          data: {
            vehiclesSold: { increment: 1 },
            totalRecoveredPaise: { increment: order.basePricePaise },
          },
        });
      }

      // Invoice stub — PDF generation can hook in async via a job queue
      await tx.invoice.create({
        data: {
          orderId: order.id,
          invoiceNumber: `INV-${new Date().getFullYear()}-${order.orderNumber.split('-').pop()}`,
        },
      });

      return { order: orderUpdated, payment: paymentUpdated };
    });

    await this.activity.log({
      type: 'PAYMENT_SUCCESS', actorId: user.id, ipAddress: ip,
      message: `Payment ${Money.formatINR(order.totalAmountPaise)} captured for order ${order.orderNumber}`,
      meta: { orderId: order.id, paymentId: payment.id, vehicleId: order.vehicleId },
    });

    this.realtime.toUser(user.id, 'order:ready-for-pickup', {
      orderId: order.id,
      orderNumber: order.orderNumber,
    });
    if (order.vehicleId) {
      this.realtime.toVehicle(order.vehicleId, 'vehicle:sold', { vehicleId: order.vehicleId });
    }
    this.realtime.toBank(order.bankId, 'pickup:new', {
      orderId: order.id,
      orderNumber: order.orderNumber,
    });

    return {
      success: true,
      order: result.order,
      qrCodeDataUrl: qrDataUrl,
      pickupPassCode: order.orderNumber,
    };
  }

  async myOrders(user: AuthUser) {
    return this.prisma.order.findMany({
      where: { buyerId: user.id },
      orderBy: { createdAt: 'desc' },
      include: {
        vehicle: {
          select: {
            id: true, make: true, model: true, year: true, registrationNumber: true,
            images: { take: 1, orderBy: { position: 'asc' } },
          },
        },
        bank: { select: { id: true, name: true, code: true } },
        branch: { select: { id: true, name: true, city: true } },
      },
    });
  }

  async getOne(user: AuthUser, id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        vehicle: { include: { images: true } },
        bank: { include: { branches: true } },
        branch: true,
        buyer: { select: { id: true, name: true, email: true, phone: true } },
        payments: true,
        invoice: true,
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    const isBuyer = order.buyerId === user.id;
    const isBankStaff = user.bankId === order.bankId;
    const isAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
    if (!isBuyer && !isBankStaff && !isAdmin) throw new ForbiddenException('Not authorized');

    return order;
  }

  /**
   * Cron task — sweep orders whose hold elapsed without payment success.
   * Marks them EXPIRED so the buyer can't accidentally pay later.
   */
  async expireOverdueOrders(): Promise<number> {
    const now = new Date();
    const result = await this.prisma.order.updateMany({
      where: {
        status: { in: [OrderStatus.HELD, OrderStatus.PAYMENT_PENDING] },
        heldUntil: { lt: now },
      },
      data: { status: OrderStatus.EXPIRED, expiredAt: now },
    });
    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} overdue order(s)`);
    }
    return result.count;
  }
}
