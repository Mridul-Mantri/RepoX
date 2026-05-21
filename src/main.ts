import './common/utils/bigint-json'; // must be first — patches BigInt.toJSON
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { RedisIoAdapter } from './modules/realtime/redis-io.adapter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // rawBody lets us verify Razorpay webhook HMAC against the exact bytes
    // received, not the re-serialized JSON.
    rawBody: true,
  });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // Security headers
  app.use(helmet({ contentSecurityPolicy: false }));

  // CORS — multi-origin for web + mobile app
  app.enableCors({
    origin: (config.get<string>('CLIENT_ORIGIN') || 'http://localhost:3000').split(','),
    credentials: true,
  });

  // Global URL prefix
  app.setGlobalPrefix('api/v1');

  // Validation — strict whitelist + transform DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Centralised error handling
  app.useGlobalFilters(new PrismaExceptionFilter(), new HttpExceptionFilter());

  // Socket.io with Redis adapter — required for horizontal scaling
  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connectToRedis();
  app.useWebSocketAdapter(ioAdapter);

  // Swagger
  if (config.get('NODE_ENV') !== 'production') {
    const swagger = new DocumentBuilder()
      .setTitle('RepoX API')
      .setDescription('Repossessed asset liquidation infrastructure')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const doc = SwaggerModule.createDocument(app, swagger);
    SwaggerModule.setup('api/docs', app, doc);
  }

  app.enableShutdownHooks();

  const port = config.get<number>('PORT') || 5000;
  await app.listen(port);
  logger.log(`🚀 RepoX API running on http://localhost:${port}/api/v1`);
  logger.log(`📚 Swagger docs at http://localhost:${port}/api/docs`);
}

bootstrap();
