import { Body, Controller, Get, Headers, Ip, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto, RegisterDto } from './auth.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/roles.decorator';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // 5 registrations/min/IP
  @Post('register')
  async register(@Body() dto: RegisterDto, @Ip() ip: string) {
    return { success: true, ...(await this.auth.register(dto, ip)) };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } }) // 10 login attempts/min/IP
  @Post('login')
  async login(@Body() dto: LoginDto, @Ip() ip: string, @Headers('user-agent') ua: string) {
    return { success: true, ...(await this.auth.login(dto, ip, ua)) };
  }

  @Public()
  @Post('refresh')
  async refresh(@Body() dto: RefreshDto, @Ip() ip: string, @Headers('user-agent') ua: string) {
    return { success: true, ...(await this.auth.refresh(dto, ip, ua)) };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@CurrentUser() user: AuthUser, @Body() dto?: { refreshToken?: string }) {
    return this.auth.logout(user.id, dto?.refreshToken);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return { success: true, user };
  }
}
