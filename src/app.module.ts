import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import * as Joi from 'joi';

import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { BanksModule } from './modules/banks/banks.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { BidsModule } from './modules/bids/bids.module';
import { LotsModule } from './modules/lots/lots.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { RfqsModule } from './modules/rfqs/rfqs.module';
import { PickupModule } from './modules/pickup/pickup.module';
import { AdminModule } from './modules/admin/admin.module';
import { ActivityModule } from './modules/activity/activity.module';
import { RealtimeModule } from './modules/realtime/realtime.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      // Fail fast on bad config
      validationSchema: Joi.object({
        NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
        PORT: Joi.number().default(5000),
        DATABASE_URL: Joi.string().required(),
        REDIS_HOST: Joi.string().required(),
        REDIS_PORT: Joi.number().default(6379),
        JWT_SECRET: Joi.string().min(32).required(),
        JWT_EXPIRES: Joi.string().default('7d'),
        JWT_REFRESH_SECRET: Joi.string().min(32).required(),
        RAZORPAY_KEY_ID: Joi.string().required(),
        RAZORPAY_KEY_SECRET: Joi.string().required(),
        HOLD_MINUTES: Joi.number().default(10),
      }).unknown(true),
    }),

    ScheduleModule.forRoot(),

    // Default rate limit for every endpoint; sensitive routes apply stricter
    // limits via @Throttle() decorator at the controller level.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),

    PrismaModule,
    RedisModule,

    AuthModule,
    UsersModule,
    BanksModule,
    VehiclesModule,
    BidsModule,
    LotsModule,
    OrdersModule,
    PaymentsModule,
    RfqsModule,
    PickupModule,
    AdminModule,
    ActivityModule,
    RealtimeModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
