import { IsNumber, IsPositive } from 'class-validator';

export class PlaceBidDto {
  @IsNumber() @IsPositive()
  amountPaise!: number;
}
