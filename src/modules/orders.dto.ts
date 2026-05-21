import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { PaymentMethod } from '@prisma/client';

export class StartCheckoutDto {
  @IsUUID()
  vehicleId!: string;

  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsOptional() @IsString()
  upiId?: string;
}

export class VerifyPaymentDto {
  @IsString() razorpayPaymentId!: string;
  @IsString() razorpaySignature!: string;
}
