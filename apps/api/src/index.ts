import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.enableShutdownHooks();
  const configService = app.get(ConfigService);
  await app.listen(configService.get<number>('PORT', 3000), '0.0.0.0');
  console.log('API HTTP listener ready');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
