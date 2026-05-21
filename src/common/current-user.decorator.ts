import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  id: string;
  email: string;
  role: 'BUYER' | 'BANK_STAFF' | 'ADMIN' | 'SUPER_ADMIN';
  buyerTier?: 'RETAIL' | 'DEALER' | 'ENTERPRISE';
  bankId?: string | null;
  kycStatus?: string;
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext): AuthUser | any => {
    const req = ctx.switchToHttp().getRequest();
    return data ? req.user?.[data] : req.user;
  },
);
