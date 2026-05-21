import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';

@Injectable()
export class QrService {
  /**
   * Encodes pickup pass info as a QR data URL. The payload is small, signed
   * by virtue of containing the unguessable orderNumber — bank staff scan it
   * and the server verifies the order is real and READY_FOR_PICKUP.
   */
  async generatePickupQr(input: {
    orderNumber: string;
    buyerId: string;
    vehicleId?: string | null;
    bankCode: string;
  }): Promise<string> {
    const payload = JSON.stringify({
      v: 1,
      t: 'REPOX_PICKUP',
      pass: input.orderNumber,
      buyer: input.buyerId,
      vehicle: input.vehicleId ?? undefined,
      bank: input.bankCode,
      iat: Date.now(),
    });
    return QRCode.toDataURL(payload, {
      errorCorrectionLevel: 'H',
      margin: 1,
      width: 320,
      color: { dark: '#0d0d0d', light: '#ffffff' },
    });
  }
}
