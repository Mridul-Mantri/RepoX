/**
 * RepoX stores every monetary amount in PAISE (1 INR = 100 paise) as BigInt
 * to avoid floating-point errors. Conversion helpers live here.
 */

export const Money = {
  rupeesToPaise(rupees: number): bigint {
    if (Number.isNaN(rupees)) throw new Error('Invalid rupee amount');
    return BigInt(Math.round(rupees * 100));
  },

  paiseToRupees(paise: bigint | number): number {
    const n = typeof paise === 'bigint' ? Number(paise) : paise;
    return n / 100;
  },

  /**
   * Compute platform fee + GST in paise.
   *  fee   = base * (feePercent / 100)
   *  gst   = fee  * (gstPercent / 100)
   *  total = base + fee + gst
   */
  computeOrderTotals(
    basePricePaise: bigint,
    feePercent: number,
    gstPercent = 18,
  ): {
    basePricePaise: bigint;
    platformFeePercent: number;
    platformFeePaise: bigint;
    gstPercent: number;
    gstOnFeePaise: bigint;
    totalAmountPaise: bigint;
  } {
    // Math in BigInt — multiply by 100 then divide by (percent * 100) to keep
    // integer precision; round-half-up at the final paise.
    const base = basePricePaise;
    const feeNumerator = base * BigInt(Math.round(feePercent * 100));
    const platformFeePaise = (feeNumerator + 5000n) / 10000n; // round to paise

    const gstNumerator = platformFeePaise * BigInt(Math.round(gstPercent * 100));
    const gstOnFeePaise = (gstNumerator + 5000n) / 10000n;

    const totalAmountPaise = base + platformFeePaise + gstOnFeePaise;

    return {
      basePricePaise: base,
      platformFeePercent: feePercent,
      platformFeePaise,
      gstPercent,
      gstOnFeePaise,
      totalAmountPaise,
    };
  },

  /** Format paise to "₹X,XX,XXX" (Indian grouping). */
  formatINR(paise: bigint | number): string {
    const rupees = this.paiseToRupees(paise);
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(rupees);
  },
};
