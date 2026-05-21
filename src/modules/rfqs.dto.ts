import {
  IsArray, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString,
  IsUUID, MaxLength, Min,
} from 'class-validator';
import { FuelType, VehicleCategory } from '@prisma/client';

export class CreateRfqDto {
  @IsString() @MaxLength(120) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @IsOptional() @IsEnum(VehicleCategory) category?: VehicleCategory;
  @IsOptional() @IsArray() @IsString({ each: true }) preferredMakes?: string[];
  @IsOptional() @IsInt() yearFrom?: number;
  @IsOptional() @IsInt() yearTo?: number;
  @IsOptional() @IsArray() @IsEnum(FuelType, { each: true }) fuelTypes?: FuelType[];
  @IsOptional() @IsArray() @IsString({ each: true }) regions?: string[];

  @IsInt() @Min(1) quantity!: number;
  @IsNumber() @IsPositive() budgetPaise!: number;

  @IsOptional() @IsDateString() closesAt?: string;
}

export class RespondToRfqDto {
  @IsNumber() @IsPositive() quotedPricePaise!: number;
  @IsInt() @Min(1) availableUnits!: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) vehicleIds?: string[];
}
