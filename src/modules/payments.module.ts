import { Module } from '@nestjs/common';
import { RazorpayService } from './razorpay.service';
import { PaymentsWebhookController } from './payments.webhook.controller';

@Module({
  controllers: [PaymentsWebhookController],
  providers: [RazorpayService],
  exports: [RazorpayService],
})
export class PaymentsModule {}
