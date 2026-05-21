import { IsString, Length, Matches } from 'class-validator';

export class ScanPickupDto {
  // Pickup pass code printed on the QR: "RPX-XXXX-XXXX"
  @IsString() @Matches(/^RPX-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  pickupPassCode!: string;
}

export class CompletePickupDto {
  @IsString() @Length(6, 6)
  otp!: string;
}
