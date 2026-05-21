import { IsEmail, IsEnum, IsOptional, IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { BuyerTier, UserRole } from '@prisma/client';

export class RegisterDto {
  @IsString() @MinLength(2) @MaxLength(80)
  name!: string;

  @IsEmail()
  email!: string;

  @IsOptional() @IsString() @Matches(/^\+?[0-9]{10,15}$/, { message: 'Invalid phone number' })
  phone?: string;

  @IsString() @MinLength(8, { message: 'Password must be at least 8 characters' })
  password!: string;

  @IsOptional() @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional() @IsEnum(BuyerTier)
  buyerTier?: BuyerTier;

  @IsOptional() @IsString()
  companyName?: string;

  @IsOptional() @IsString() @Matches(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/, {
    message: 'Invalid GSTIN format',
  })
  gstin?: string;
}

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}
