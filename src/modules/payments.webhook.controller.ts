import {
  BadRequestException, Body, Controller, Headers, Logger, Post, Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RazorpayService } from './razorpay.service';
import { ActivityService } from '../activity/activity.service';
import { Public } from '../../common/decorators/roles.decorator';
import { PaymentStatus } from '@prisma/client';

/**
 * Webhook endpoint for Razorpay async events. The frontend's verify-payment
 * call is the happy path; webhooks are the safety net for:
 *   - payment.captured (server-to-server confirmation)
 *   - payment.failed
 *   - refund.processed
 *
 * Idempotent: every event has an `eventId` we persist to prevent replay.
 */
@ApiTags('Payments')
@Controller('payments')
export class PaymentsWebhookController {
  private readonly logger = new Logger(PaymentsWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayService,
    private readonly activity: ActivityService,
  ) {}

  @Public()
  @Post('webhook/razorpay')
  async webhook(
    @Req() req: Request,
    @Headers('x-razorpay-signature') signature: string,
    @Body() body: any,
  ) {
    // For real signature verification we need the *raw* body bytes. Nest by
    // default parses JSON first. In main.ts we should mount a raw body parser
    // for this exact path — see README. Here we serialize as best-effort.
    const raw = (req as any).rawBody?.toString('utf8') ?? JSON.stringify(body);
    const ok = this.razorpay.verifyWebhookSignature(raw, signature);
    if (!ok) throw new BadRequestException('Invalid webhook signature');

    const eventId: string = body.event_id || body.payload?.payment?.entity?.id || JSON.stringify(body).slice(0, 64);
    const eventType: string = body.event;

    // Idempotency check
    const already = await this.prisma.paymentWebhookEvent.findUnique({ where: { eventId } });
    if (already?.processed) return { success: true, deduplicated: true };

    const event = already ?? await this.prisma.paymentWebhookEvent.create({
      data: { eventId, eventType, payload: body, signature, processed: false },
    });

    try {
      await this.process(eventType, body);
      await this.prisma.paymentWebhookEvent.update({
        where: { id: event.id }, data: { processed: true },
      });
      return { success: true };
    } catch (err: any) {
      this.logger.error(`Webhook processing failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  private async process(eventType: string, body: any) {
    switch (eventType) {
      case 'payment.captured': {
        const rzPaymentId = body.payload?.payment?.entity?.id;
        const rzOrderId = body.payload?.payment?.entity?.order_id;
        if (!rzOrderId) return;
        const payment = await this.prisma.payment.findUnique({ where: { razorpayOrderId: rzOrderId } });
        if (!payment) return;
        if (payment.status === PaymentStatus.CAPTURED) return;
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.CAPTURED,
            razorpayPaymentId: rzPaymentId,
            capturedAt: new Date(),
          },
        });
        await this.activity.log({
          type: 'PAYMENT_WEBHOOK_CAPTURED',
          message: `Webhook confirmed payment captured (${rzPaymentId})`,
          meta: { paymentId: payment.id, rzOrderId, rzPaymentId },
        });
        break;
      }
      case 'payment.failed': {
        const rzOrderId = body.payload?.payment?.entity?.order_id;
        const reason = body.payload?.payment?.entity?.error_description;
        if (!rzOrderId) return;
        const payment = await this.prisma.payment.findUnique({ where: { razorpayOrderId: rzOrderId } });
        if (!payment) return;
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.FAILED, failureReason: reason },
        });
        await this.activity.log({
          type: 'PAYMENT_FAILED', level: 'WARN' as any,
          message: `Payment failed via webhook: ${reason}`,
          meta: { paymentId: payment.id, rzOrderId },
        });
        break;
      }
      case 'refund.processed': {
        const rzPaymentId = body.payload?.refund?.entity?.payment_id;
        const refundAmount = body.payload?.refund?.entity?.amount;
        if (!rzPaymentId) return;
        const payment = await this.prisma.payment.findUnique({
          where: { razorpayPaymentId: rzPaymentId },
        });
        if (!payment) return;
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.REFUNDED,
            refundedAt: new Date(),
            refundAmountPaise: BigInt(refundAmount),
          },
        });
        break;
      }
      default:
        // Ignore unhandled event types; they're still persisted for audit.
        break;
    }
  }
}
