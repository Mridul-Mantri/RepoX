import {
  IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsOptional,
  IsString, IsUUID, MaxLength,
} from 'class-validator';
import { LotStatus } from '@prisma/client';

export class CreateLotDto {
  @IsString() @MaxLength(120) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsInt() yearFrom?: number;
  @IsOptional() @IsInt() yearTo?: number;

  @IsArray() @IsUUID('all', { each: true })
  vehicleIds!: string[];

  @IsNumber() reservePricePaise!: number;
  @IsOptional() @IsBoolean() isPrivate?: boolean;
  @IsOptional() @IsDateString() auctionStartAt?: string;
  @IsOptional() @IsDateString() auctionEndAt?: string;
}

export class ListLotsQueryDto {
  @IsOptional() @IsEnum(LotStatus) status?: LotStatus;
  @IsOptional() @IsUUID() bankId?: string;
  @IsOptional() @IsString() region?: string;
}
