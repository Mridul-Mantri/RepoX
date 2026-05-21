import { Injectable, ConflictException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ActivityService } from '../activity/activity.service';
import { LoginDto, RegisterDto, RefreshDto } from './auth.dto';
import { BuyerTier, UserRole } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly activity: ActivityService,
  ) {}

  async register(dto: RegisterDto, ip?: string) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    // Self-service registration is buyer-only. Bank staff and admins are
    // created by an existing admin via /api/v1/admin/users.
    const role = UserRole.BUYER;
    const tier = dto.buyerTier ?? BuyerTier.RETAIL;

    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email.toLowerCase(),
        phone: dto.phone,
        passwordHash,
        role,
        buyerTier: tier,
        companyName: dto.companyName,
        gstin: dto.gstin,
      },
      select: {
        id: true, email: true, name: true, role: true, buyerTier: true,
        bankId: true, kycStatus: true,
      },
    });

    await this.activity.log({
      type: 'USER_REGISTERED',
      message: `New ${role} registered: ${user.email}`,
      actorId: user.id,
      ipAddress: ip,
    });

    return this.issueTokens(user, ip);
  }

  async login(dto: LoginDto, ip?: string, userAgent?: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      select: {
        id: true, email: true, name: true, role: true, buyerTier: true,
        bankId: true, kycStatus: true, passwordHash: true, isActive: true,
      },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new ForbiddenException('Account deactivated');

    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: ip },
    });

    await this.activity.log({
      type: 'USER_LOGIN', actorId: user.id,
      message: `Login: ${user.email}`, ipAddress: ip,
    });

    const { passwordHash, isActive, ...safe } = user;
    return this.issueTokens(safe, ip, userAgent);
  }

  async refresh(dto: RefreshDto, ip?: string, userAgent?: string) {
    const tokenHash = this.hashToken(dto.refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          select: {
            id: true, email: true, name: true, role: true, buyerTier: true,
            bankId: true, kycStatus: true, isActive: true,
          },
        },
      },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date() || !stored.user.isActive) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    // Rotate — invalidate the old token, issue a new pair
    await this.prisma.refreshToken.update({
      where: { id: stored.id }, data: { revokedAt: new Date() },
    });

    const { isActive, ...safe } = stored.user;
    return this.issueTokens(safe, ip, userAgent);
  }

  async logout(userId: string, refreshToken?: string) {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      await this.prisma.refreshToken.updateMany({
        where: { userId, tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } else {
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null }, data: { revokedAt: new Date() },
      });
    }
    return { success: true };
  }

  // ---- private ---------------------------------------------------------------

  private async issueTokens(user: any, ip?: string, userAgent?: string) {
    const payload = { sub: user.id, email: user.email, role: user.role };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.get('JWT_SECRET'),
      expiresIn: this.config.get('JWT_EXPIRES') || '7d',
    });

    const refreshTokenRaw = randomBytes(48).toString('hex');
    const refreshTokenHash = this.hashToken(refreshTokenRaw);
    const refreshExpiresDays = this.parseExpiresToDays(this.config.get('JWT_REFRESH_EXPIRES') || '30d');

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: refreshTokenHash,
        expiresAt: new Date(Date.now() + refreshExpiresDays * 24 * 60 * 60 * 1000),
        ipAddress: ip,
        userAgent: userAgent?.slice(0, 200),
      },
    });

    return { user, accessToken, refreshToken: refreshTokenRaw };
  }

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private parseExpiresToDays(s: string): number {
    const m = s.match(/^(\d+)([dh])$/);
    if (!m) return 30;
    return m[2] === 'd' ? Number(m[1]) : Number(m[1]) / 24;
  }
}
