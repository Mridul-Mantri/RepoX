import {
  IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsPositive,
  IsString, Min, Max, MaxLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  VehicleCategory, FuelType, Transmission, VehicleCondition, SaleType, VehicleStatus,
} from '@prisma/client';

export class CreateVehicleDto {
  @IsString() @MaxLength(20)
  registrationNumber!: string;

  @IsString() make!: string;
  @IsString() model!: string;
  @IsOptional() @IsString() variant?: string;
  @IsInt() @Min(1990) @Max(new Date().getFullYear() + 1) year!: number;
  @IsOptional() @IsString() color?: string;

  @IsEnum(VehicleCategory) category!: VehicleCategory;
  @IsOptional() @IsEnum(FuelType) fuelType?: FuelType;
  @IsOptional() @IsEnum(Transmission) transmission?: Transmission;
  @IsOptional() @IsInt() @Min(0) kmDriven?: number;
  @IsOptional() @IsInt() @Min(1) @Max(10) ownerCount?: number;
  @IsOptional() @IsDateString() insuranceValidTill?: string;
  @IsOptional() @IsBoolean() rcAvailable?: boolean;

  @IsOptional() @IsEnum(VehicleCondition) condition?: VehicleCondition;
  @IsOptional() @IsString() @MaxLength(2000) inspectionNotes?: string;
  @IsOptional() @IsString() inspectionReportUrl?: string;

  @IsOptional() @IsArray() @IsString({ each: true }) imageUrls?: string[];

  @IsEnum(SaleType) saleType!: SaleType;
  // Prices in PAISE (client should convert from rupees * 100)
  @IsNumber() @IsPositive() reservePricePaise!: number;
  @IsOptional() @IsNumber() @IsPositive() buyNowPricePaise?: number;
  @IsOptional() @IsNumber() @IsPositive() startingBidPaise?: number;

  @IsOptional() @IsDateString() auctionStartAt?: string;
  @IsOptional() @IsDateString() auctionEndAt?: string;

  @IsOptional() @IsString() branchId?: string;
}

export class UpdateVehicleDto {
  @IsOptional() @IsString() variant?: string;
  @IsOptional() @IsInt() kmDriven?: number;
  @IsOptional() @IsString() inspectionNotes?: string;
  @IsOptional() @IsEnum(VehicleCondition) condition?: VehicleCondition;
  @IsOptional() @IsNumber() reservePricePaise?: number;
  @IsOptional() @IsNumber() buyNowPricePaise?: number;
  @IsOptional() @IsDateString() auctionEndAt?: string;
  @IsOptional() @IsEnum(VehicleStatus) status?: VehicleStatus;
}

export class ListVehiclesQueryDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsEnum(SaleType) saleType?: SaleType;
  @IsOptional() @IsEnum(VehicleCategory) category?: VehicleCategory;
  @IsOptional() @IsEnum(FuelType) fuelType?: FuelType;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() bankId?: string;
  @IsOptional() @Type(() => Number) @IsNumber() minPricePaise?: number;
  @IsOptional() @Type(() => Number) @IsNumber() maxPricePaise?: number;
  @IsOptional() @IsString() sort?: 'ending' | 'price_asc' | 'price_desc' | 'newest';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(60) limit?: number = 12;
}
