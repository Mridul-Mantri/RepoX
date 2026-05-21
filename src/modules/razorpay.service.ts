import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { v4 as uuid } from 'uuid';

/**
 * Razorpay integration. In dev (test keys with x's), we return a mocked order
 * object so the full flow can be exercised end-to-end without real credentials.
 * Production must set real keys — signature verification is then enforced.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);
  private client: any = null;
  private readonly mockMode: boolean;
  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;

  constructor(config: ConfigService) {
    this.keyId = config.get<string>('RAZORPAY_KEY_ID') || '';
    this.keySecret = config.get<string>('RAZORPAY_KEY_SECRET') || '';
    this.webhookSecret = config.get<string>('RAZORPAY_WEBHOOK_SECRET') || '';
    this.mockMode = !this.keyId || this.keyId.includes('xxxx');

    if (!this.mockMode) {
      // Lazy-require so the dep is optional in dev
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Razorpay = require('razorpay');
      this.client = new Razorpay({ key_id: this.keyId, key_secret: this.keySecret });
    } else {
      this.logger.warn('Razorpay running in MOCK mode — no real charges will occur');
    }
  }

  get publicKeyId(): string {
    return this.keyId;
  }

  async createOrder(input: {
    amountPaise: bigint;
    receipt: string;
    notes?: Record<string, string>;
  }) {
    const amount = Number(input.amountPaise); // Razorpay takes integer paise
    if (this.mockMode) {
      return {
        id: `order_mock_${uuid().slice(0, 16)}`,
        entity: 'order',
        amount,
        currency: 'INR',
        receipt: input.receipt,
        status: 'created',
        notes: input.notes ?? {},
        _mock: true,
      };
    }
    return this.client.orders.create({
      amount,
      currency: 'INR',
      receipt: input.receipt,
      notes: input.notes,
    });
  }

  /**
   * Verify the HMAC-SHA256 signature Razorpay returns after a successful
   * payment. In mock mode we accept any signature so test flows pass.
   */
  verifyPaymentSignature(input: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }): boolean {
    if (this.mockMode) return true;
    const expected = createHmac('sha256', this.keySecret)
      .update(`${input.razorpayOrderId}|${input.razorpayPaymentId}`)
      .digest('hex');
    return expected === input.razorpaySignature;
  }

  /**
   * Verify webhook signature (different envelope than payment signature).
   * Razorpay sends X-Razorpay-Signature header — HMAC-SHA256 of the raw
   * request body using the webhook secret.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (this.mockMode) return true;
    if (!this.webhookSecret) return false;
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    return expected === signature;
  }

  async refund(razorpayPaymentId: string, amountPaise: bigint, reason?: string) {
    if (this.mockMode) {
      return { id: `rfnd_mock_${uuid().slice(0, 12)}`, amount: Number(amountPaise), status: 'processed' };
    }
    return this.client.payments.refund(razorpayPaymentId, {
      amount: Number(amountPaise),
      notes: { reason: reason ?? 'standard_refund' },
    });
  }
}
