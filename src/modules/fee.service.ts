import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BuyerTier } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Resolves the platform fee % for a buyer tier. DB FeeSetting rows are the
 * source of truth; .env values are the bootstrap defaults used until an admin
 * customises them via /admin/fees.
 */
@Injectable()
export class FeeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getFeeForTier(tier: BuyerTier): Promise<{ feePercent: number; gstPercent: number }> {
    const row = await this.prisma.feeSetting.findUnique({ where: { tier } });
    if (row) {
      return { feePercent: Number(row.percent), gstPercent: Number(row.gstPercent) };
    }
    // Fallback to env defaults
    const defaults: Record<BuyerTier, number> = {
      RETAIL: this.config.get<number>('FEE_RETAIL') ?? 2.5,
      DEALER: this.config.get<number>('FEE_DEALER') ?? 1.5,
      ENTERPRISE: this.config.get<number>('FEE_ENTERPRISE') ?? 1.0,
    };
    return {
      feePercent: defaults[tier],
      gstPercent: this.config.get<number>('GST_PERCENT') ?? 18,
    };
  }
}
